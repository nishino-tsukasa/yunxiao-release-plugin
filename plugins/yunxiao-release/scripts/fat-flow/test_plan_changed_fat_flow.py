#!/usr/bin/env python3
"""流水线计划执行适配器的回归测试。"""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yunxiao_env as YUNXIAO_ENV


MODULE_PATH = Path(__file__).resolve().parent / "plan_changed_fat_flow.py"
SPEC = importlib.util.spec_from_file_location("plan_changed_fat_flow", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载模块：{MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ExecuteEnvironmentReleasePlanTest(unittest.TestCase):
    """只覆盖执行职责；配置解析和计划生成由 Node module 测试。"""

    def test_parse_devops_output_should_support_json_number_and_plain_text(self) -> None:
        self.assertEqual({"pipelineRunId": 145}, MODULE.parse_devops_output('{"pipelineRunId":145}'))
        self.assertEqual(145, MODULE.parse_devops_output("145\n"))
        self.assertEqual({"raw": "unexpected-text"}, MODULE.parse_devops_output("unexpected-text"))

    def test_extract_pipeline_run_id_should_support_legacy_result_shapes(self) -> None:
        self.assertEqual("145", MODULE.extract_pipeline_run_id(145))
        self.assertEqual("145", MODULE.extract_pipeline_run_id({"raw": "145"}))
        self.assertEqual("145", MODULE.extract_pipeline_run_id({"data": {"pipelineRunId": 145}}))

    def test_list_running_pipeline_runs_should_use_filtered_flow_endpoint(self) -> None:
        with patch.object(YUNXIAO_ENV, "resolve_organization_id", return_value="org"), patch.object(
            YUNXIAO_ENV, "http_json_request", return_value=[{"pipelineRunId": 7}],
        ) as request:
            result = YUNXIAO_ENV.run_devops([
                "flow-list-pipeline-runs", "--pipeline-id", "100", "--status", "RUNNING",
            ])
        self.assertEqual(result.returncode, 0)
        request.assert_called_once_with("GET", "/oapi/v1/flow/organizations/org/pipelines/100/runs",
                                        query={"page": "1", "perPage": "30", "status": "RUNNING"})

    def test_execute_plan_should_finish_client_stage_before_server_stage(self) -> None:
        plan = {
            "unresolved": [],
            "changedProjects": ["backend-service"],
            "stages": [
                {"name": "backend-client-package", "steps": [{"project": "backend-service"}]},
                {"name": "backend-server-deploy", "steps": [{"project": "backend-service"}]},
            ],
        }
        with patch.object(MODULE, "require_yunxiao_env"), patch.object(
            MODULE,
            "execute_stage",
            side_effect=[[{"project": "backend-service"}], [{"project": "backend-service"}]],
        ) as execute_stage:
            MODULE.execute_plan(plan, 1, {
                "backend-client-package": {"initialWaitSeconds": 0, "timeoutSeconds": 1},
                "backend-server-deploy": {"initialWaitSeconds": 0, "timeoutSeconds": 1},
            }, False)

        self.assertEqual(
            ["backend-client-package", "backend-server-deploy"],
            [call.args[0]["name"] for call in execute_stage.call_args_list],
        )
        self.assertEqual(1, execute_stage.call_args_list[0].args[5])
        self.assertEqual(2, execute_stage.call_args_list[1].args[5])

    def test_execute_plan_should_reject_unresolved_plan_before_running(self) -> None:
        plan = {"unresolved": ["missing pipeline"], "changedProjects": [], "stages": []}
        with patch.object(MODULE, "require_yunxiao_env"), patch.object(MODULE, "execute_stage") as execute_stage:
            with self.assertRaisesRegex(RuntimeError, "存在未配置映射"):
                MODULE.execute_plan(plan, 1, {}, False)
        execute_stage.assert_not_called()

    def test_execute_plan_should_finish_provider_server_before_consumer_server(self) -> None:
        stages = lambda project: [
            {"name": "backend-client-package", "steps": [{"project": project}]},
            {"name": "backend-server-deploy", "steps": [{"project": project}]},
        ]
        plan = {
            "unresolved": [], "changedProjects": ["wx", "core"],
            "waves": [{"stages": stages("wx")}, {"stages": stages("core")}],
        }
        with patch.object(MODULE, "require_yunxiao_env"), patch.object(
            MODULE, "execute_stage", side_effect=[[{"project": "wx"}], [{"project": "wx"}],
                                                 [{"project": "core"}], [{"project": "core"}]],
        ) as execute_stage:
            MODULE.execute_plan(plan, 1, {
                "backend-client-package": {"timeoutSeconds": 1},
                "backend-server-deploy": {"timeoutSeconds": 1},
            }, False)
        self.assertEqual(
            [(call.args[0]["name"], call.args[0]["steps"][0]["project"]) for call in execute_stage.call_args_list],
            [("backend-client-package", "wx"), ("backend-server-deploy", "wx"),
             ("backend-client-package", "core"), ("backend-server-deploy", "core")],
        )

    def test_resume_should_reuse_successful_run_without_triggering_again(self) -> None:
        plan = {"environment": "fat", "branch": "fat/fat", "changedProjects": ["wx"], "stages": []}
        step = {"type": "pipeline", "project": "wx", "pipelineName": "client", "pipelineId": "100", "journalKey": "0:client:wx:0"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            journal = MODULE.ExecutionJournal(path, plan, False)
            with patch.object(MODULE, "run_flow_step", return_value={"pipelineRunResult": {"pipelineRunId": 7}}) as trigger, patch.object(
                MODULE, "get_pipeline_run", return_value={"status": "SUCCESS"},
            ):
                MODULE.wait_flow_step(dict(step), 0, 1, False, journal=journal)
                self.assertEqual(trigger.call_count, 1)
            resumed = MODULE.ExecutionJournal(path, plan, True)
            with patch.object(MODULE, "run_flow_step") as trigger, patch.object(
                MODULE, "get_pipeline_run", return_value={"status": "SUCCESS"},
            ):
                MODULE.wait_flow_step(dict(step), 0, 1, False, journal=resumed)
                trigger.assert_not_called()
            changed = {**plan, "branch": "another"}
            with self.assertRaisesRegex(RuntimeError, "计划不一致"):
                MODULE.ExecutionJournal(path, changed, True)

    def test_resume_should_not_retrigger_unknown_result(self) -> None:
        plan = {"changedProjects": ["wx"], "stages": []}
        step = {"type": "pipeline", "project": "wx", "pipelineName": "client", "pipelineId": "100", "journalKey": "step"}
        with tempfile.TemporaryDirectory() as directory:
            journal = MODULE.ExecutionJournal(Path(directory) / "state.json", plan, False)
            journal.record("step", phase="triggering", pipelineId="100")
            with patch.object(MODULE, "run_flow_step") as trigger:
                with self.assertRaisesRegex(RuntimeError, "结果未知"):
                    MODULE.wait_flow_step(step, 0, 1, False, journal=journal)
                trigger.assert_not_called()

    def test_client_should_choose_free_shared_pipeline_and_pin_resume_choice(self) -> None:
        candidates = [
            {"pipelineId": "100", "pipelineName": "shared-a", "params": {"envs": {"project": "wx"}}},
            {"pipelineId": "101", "pipelineName": "shared-b", "params": {"envs": {"project": "wx"}}},
        ]
        step = {"project": "wx", "pipelineId": "100", "pipelineName": "shared-a",
                "params": candidates[0]["params"], "candidates": candidates, "journalKey": "0:client:wx:0"}
        with tempfile.TemporaryDirectory() as directory:
            journal = MODULE.ExecutionJournal(Path(directory) / "state.json", {"changedProjects": ["wx"]}, False)
            with patch.object(MODULE, "pipeline_has_running_run", side_effect=lambda pipeline_id: pipeline_id == "100") as check:
                MODULE.assign_client_pipelines([step], 0, 1, journal)
            self.assertEqual(step["pipelineId"], "101")
            self.assertEqual(check.call_count, 2)
            journal.record(step["journalKey"], phase="triggered", pipelineId="101", runId="7")
            resumed_step = {**step, "pipelineId": "100", "pipelineName": "shared-a"}
            with patch.object(MODULE, "pipeline_has_running_run") as check:
                MODULE.assign_client_pipelines([resumed_step], 0, 1, journal)
                check.assert_not_called()
            self.assertEqual(resumed_step["pipelineId"], "101")

    def test_client_should_not_trigger_when_all_candidates_are_busy(self) -> None:
        step = {"project": "wx", "pipelineId": "100", "pipelineName": "shared-a", "params": {},
                "journalKey": "0:client:wx:0"}
        with patch.object(MODULE, "pipeline_has_running_run", return_value=True):
            with self.assertRaisesRegex(TimeoutError, "都在运行"):
                MODULE.assign_client_pipelines([step], 0, 0, None)


if __name__ == "__main__":
    unittest.main()

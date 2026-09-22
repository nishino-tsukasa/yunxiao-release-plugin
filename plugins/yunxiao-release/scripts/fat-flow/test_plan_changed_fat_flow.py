#!/usr/bin/env python3
"""流水线计划执行适配器的回归测试。"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


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

    def test_execute_plan_should_finish_client_stage_before_server_stage(self) -> None:
        plan = {
            "unresolved": [],
            "changedProjects": ["backend-service"],
            "stages": [
                {"name": "client-package", "steps": [{"project": "backend-service"}]},
                {"name": "server-deploy", "steps": [{"project": "backend-service"}]},
            ],
        }
        with patch.object(MODULE, "require_yunxiao_env"), patch.object(
            MODULE,
            "execute_stage",
            side_effect=[[{"project": "backend-service"}], [{"project": "backend-service"}]],
        ) as execute_stage:
            MODULE.execute_plan(plan, 1, 0, 1, 1, False)

        self.assertEqual(
            ["client-package", "server-deploy"],
            [call.args[0]["name"] for call in execute_stage.call_args_list],
        )
        self.assertEqual(1, execute_stage.call_args_list[0].args[5])
        self.assertEqual(2, execute_stage.call_args_list[1].args[5])

    def test_execute_plan_should_reject_unresolved_plan_before_running(self) -> None:
        plan = {"unresolved": ["missing pipeline"], "changedProjects": [], "stages": []}
        with patch.object(MODULE, "require_yunxiao_env"), patch.object(MODULE, "execute_stage") as execute_stage:
            with self.assertRaisesRegex(RuntimeError, "存在未配置映射"):
                MODULE.execute_plan(plan, 1, 0, 1, 1, False)
        execute_stage.assert_not_called()


if __name__ == "__main__":
    unittest.main()

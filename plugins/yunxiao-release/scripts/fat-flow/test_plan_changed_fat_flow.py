#!/usr/bin/env python3
"""plan_changed_fat_flow.py 的回归测试。"""

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


class PlanChangedFatFlowTest(unittest.TestCase):
    """覆盖云效返回值兼容场景的回归测试。"""

    def test_parse_devops_output_should_parse_json_object(self) -> None:
        """JSON 对象输出应被正常解析。"""
        result = MODULE.parse_devops_output('{"pipelineRunId":145}')
        self.assertEqual({"pipelineRunId": 145}, result)

    def test_parse_devops_output_should_parse_raw_number(self) -> None:
        """裸数字输出应被识别为流水线运行 ID。"""
        result = MODULE.parse_devops_output("145\n")
        self.assertEqual(145, result)

    def test_parse_devops_output_should_preserve_plain_text(self) -> None:
        """非 JSON 文本输出应被保留到 raw 字段。"""
        result = MODULE.parse_devops_output("unexpected-text")
        self.assertEqual({"raw": "unexpected-text"}, result)

    def test_extract_pipeline_run_id_should_support_integer(self) -> None:
        """整数形式的 runId 应能直接提取。"""
        run_id = MODULE.extract_pipeline_run_id(145)
        self.assertEqual("145", run_id)

    def test_extract_pipeline_run_id_should_support_raw_numeric_text(self) -> None:
        """raw 字段中的数字字符串应能提取为 runId。"""
        run_id = MODULE.extract_pipeline_run_id({"raw": "145"})
        self.assertEqual("145", run_id)

    def test_extract_pipeline_run_id_should_support_nested_json(self) -> None:
        """嵌套 JSON 中的 pipelineRunId 应能提取。"""
        run_id = MODULE.extract_pipeline_run_id({"data": {"pipelineRunId": 145}})
        self.assertEqual("145", run_id)

    def test_default_organization_id_should_match_installation_document(self) -> None:
        """默认组织 ID 常量应保持与安装说明一致。"""
        self.assertFalse(hasattr(MODULE, "DEFAULT_ORGANIZATION_ID"))

    def test_should_package_client_should_default_true_when_not_explicit(self) -> None:
        """未显式传入 client 项目集合时，默认仍为项目生成 client 计划。"""
        self.assertTrue(MODULE.should_package_client("monkey-order", None))

    def test_frontend_project_should_use_develop_target_branch(self) -> None:
        """以 -web 结尾的项目应使用 develop 作为 FAT 目标分支。"""
        config = {"branch": "fat/fat", "branches": {"frontend": "develop", "backend": "fat/fat"}}
        self.assertTrue(MODULE.is_frontend_project("monkey-saas-web"))
        self.assertEqual("develop", MODULE.resolve_target_branch("monkey-saas-web", config))
        self.assertEqual("fat/fat", MODULE.resolve_target_branch("monkey-order", config))

    def test_build_plan_should_create_frontend_stage_without_backend_stages(self) -> None:
        """前端项目应只生成前端部署步骤，不应进入后端 client 或 server 映射。"""
        config = {
            "branch": "fat/fat",
            "branches": {"frontend": "develop", "backend": "fat/fat"},
            "frontendDeploy": {
                "defaultEnv": "fat",
                "defaultEnvName": "default",
                "projects": {
                    "monkey-saas-web": {
                        "name": "frontend-pipeline",
                        "pipelineId": "3001",
                        "envs": {
                            "branch": "{branch}",
                            "project": "{project}",
                            "envName": "{envName}",
                            "feishuId": "{feishuId}",
                        },
                    }
                },
            },
            "clientPackage": {"skipProjects": []},
            "serverDeploy": {"skipProjects": [], "projects": {}},
        }
        plan = MODULE.build_plan(["monkey-saas-web"], config, False, set())
        frontend_stage = next(stage for stage in plan["stages"] if stage["name"] == "frontend-deploy")
        client_stage = next(stage for stage in plan["stages"] if stage["name"] == "client-package")
        server_stage = next(stage for stage in plan["stages"] if stage["name"] == "server-deploy")
        self.assertEqual("develop", plan["branch"])
        self.assertEqual("develop", frontend_stage["steps"][0]["params"]["envs"]["branch"])
        self.assertEqual([], client_stage["steps"])
        self.assertEqual([], server_stage["steps"])
        self.assertEqual([], plan["unresolved"])

    def test_build_plan_should_use_independent_target_branches_for_mixed_projects(self) -> None:
        """混合项目计划应分别向前端 develop 和后端 fat/fat 传递分支。"""
        config = {
            "branch": "fat/fat",
            "branches": {"frontend": "develop", "backend": "fat/fat"},
            "frontendDeploy": {
                "projects": {
                    "monkey-saas-web": {
                        "name": "frontend-pipeline",
                        "pipelineId": "3001",
                        "envs": {"branch": "{branch}", "project": "{project}"},
                    }
                }
            },
            "clientPackage": {
                "defaultEnv": "fat",
                "defaultFeishuId": "",
                "skipProjects": [],
                "frameworkPipeline": {
                    "name": "client-pipeline",
                    "pipelineId": "1001",
                    "projects": ["monkey-order"],
                    "envs": {"branch": "{branch}", "project": "{project}", "env": "{env}"},
                },
                "javaServicePipelines": [],
            },
            "serverDeploy": {
                "defaultEnv": "fat",
                "skipProjects": [],
                "projects": {
                    "monkey-order": {
                        "name": "server-pipeline",
                        "pipelineId": "2001",
                        "envs": {"branch": "{branch}", "env": "{env}"},
                    }
                },
            },
        }
        plan = MODULE.build_plan(["monkey-saas-web", "monkey-order"], config, False, None)
        frontend_stage = next(stage for stage in plan["stages"] if stage["name"] == "frontend-deploy")
        client_stage = next(stage for stage in plan["stages"] if stage["name"] == "client-package")
        server_stage = next(stage for stage in plan["stages"] if stage["name"] == "server-deploy")
        self.assertEqual("mixed", plan["branch"])
        self.assertEqual("develop", frontend_stage["steps"][0]["params"]["envs"]["branch"])
        self.assertEqual("fat/fat", client_stage["steps"][0]["params"]["envs"]["branch"])
        self.assertEqual("fat/fat", server_stage["steps"][0]["params"]["envs"]["branch"])

    def test_should_package_client_should_follow_explicit_project_set(self) -> None:
        """显式传入 client 项目集合后，只对集合内项目生成 client 计划。"""
        explicit_projects = {"monkey-order"}
        self.assertTrue(MODULE.should_package_client("monkey-order", explicit_projects))
        self.assertFalse(MODULE.should_package_client("monkey-user", explicit_projects))

    def test_build_plan_should_skip_client_steps_when_explicit_client_projects_is_empty(self) -> None:
        """显式指定本次无需打任何 client 包时，计划中不应生成 client 步骤。"""
        config = {
            "branch": "fat/fat",
            "clientPackage": {
                "defaultEnv": "fat",
                "defaultFeishuId": "",
                "skipProjects": [],
                "frameworkPipeline": {
                    "name": "client-pipeline",
                    "pipelineId": "1001",
                    "projects": ["monkey-order"],
                    "envs": {
                        "branch": "{branch}",
                        "project": "{project}",
                        "env": "{env}",
                        "feishuId": "{feishuId}"
                    }
                },
                "javaServicePipelines": []
            },
            "serverDeploy": {
                "defaultEnv": "fat",
                "skipProjects": [],
                "projects": {
                    "monkey-order": {
                        "name": "server-pipeline",
                        "pipelineId": "2001",
                        "envs": {
                            "branch": "{branch}",
                            "env": "{env}"
                        }
                    }
                }
            }
        }
        plan = MODULE.build_plan(["monkey-order"], config, False, set())
        client_stage = next(stage for stage in plan["stages"] if stage["name"] == "client-package")
        server_stage = next(stage for stage in plan["stages"] if stage["name"] == "server-deploy")
        self.assertEqual([], client_stage["steps"])
        self.assertEqual(1, len(server_stage["steps"]))

    def test_execute_plan_should_finish_all_client_steps_before_server_stage(self) -> None:
        """server 阶段必须在整个 client 阶段完成后才允许开始。"""
        plan = {
            "unresolved": [],
            "changedProjects": ["monkey-order"],
            "stages": [
                {"name": "client-package", "steps": [{"project": "monkey-order"}]},
                {"name": "server-deploy", "steps": [{"project": "monkey-order"}]},
            ],
        }
        with patch.object(MODULE, "require_yunxiao_env"), \
                patch.object(MODULE, "execute_stage", side_effect=[[{"project": "monkey-order"}], [{"project": "monkey-order"}]]) as execute_stage:
            MODULE.execute_plan(plan, 1, 0, 1, 1, False)

        self.assertEqual(["client-package", "server-deploy"], [call.args[0]["name"] for call in execute_stage.call_args_list])
        self.assertEqual(1, execute_stage.call_args_list[0].args[5])
        self.assertEqual(2, execute_stage.call_args_list[1].args[5])


if __name__ == "__main__":
    unittest.main()

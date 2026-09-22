import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from fat_flow_config import load_config, needs_client_package, normalize_remote_url, project_config_for_repo


class FatFlowConfigTest(unittest.TestCase):
    def write_config(self, root: Path, repositories: dict) -> dict:
        defaults = root / "global-defaults.json"
        repository_file = root / "global-repositories.json"
        defaults.write_text(json.dumps({"schemaVersion": 1, "fatFlow": {"execution": {}}}), encoding="utf-8")
        repository_file.write_text(
            json.dumps({"schemaVersion": 1, "repositories": repositories}), encoding="utf-8"
        )
        return load_config(defaults, repository_file)

    def init_repo(self, root: Path, name: str, remote_url: str) -> Path:
        repo = root / name
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(["git", "remote", "add", "upstream", remote_url], cwd=repo, check=True)
        return repo

    def test_normalize_remote_url_supports_ssh_and_https(self):
        expected = "example.com/team/service"
        self.assertEqual(normalize_remote_url("git@example.com:team/service.git"), expected)
        self.assertEqual(normalize_remote_url("https://example.com/team/service.git/"), expected)

    def test_repository_is_selected_by_remote_not_directory_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.write_config(
                root,
                {"example.com/team/service": {"remoteName": "upstream", "fatTargetBranch": "testing"}},
            )
            repo = self.init_repo(root, "renamed-directory", "git@example.com:team/service.git")
            self.assertEqual(project_config_for_repo(repo, config)["fatTargetBranch"], "testing")

    def test_client_decision_uses_explicit_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = self.init_repo(root, "service", "https://example.com/team/service.git")
            never_config = self.write_config(
                root,
                {"example.com/team/service": {"clientDetection": {"mode": "never"}}},
            )
            always_config = self.write_config(
                root,
                {"example.com/team/service": {"clientDetection": {"mode": "always"}}},
            )
            self.assertFalse(needs_client_package(repo, "topic", never_config))
            self.assertTrue(needs_client_package(repo, "topic", always_config))

    def test_missing_repository_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.write_config(root, {"example.com/team/other": {}})
            repo = self.init_repo(root, "unknown", "https://example.com/team/unknown.git")
            with self.assertRaisesRegex(ValueError, "未登记项目"):
                project_config_for_repo(repo, config)


if __name__ == "__main__":
    unittest.main()

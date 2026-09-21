#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

for test_file in plugins/yunxiao-release/scripts/*.test.mjs; do
  node "$test_file"
done
python3 plugins/yunxiao-release/scripts/fat-flow/test_plan_changed_fat_flow.py
bash install.test.sh
bash install-claude.test.sh

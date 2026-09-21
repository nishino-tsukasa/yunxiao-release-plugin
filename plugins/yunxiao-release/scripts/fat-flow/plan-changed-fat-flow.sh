#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -u "${SCRIPT_DIR}/plan_changed_fat_flow.py" "$@"

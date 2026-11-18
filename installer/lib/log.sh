#!/usr/bin/env bash
# Cloudlane installer — log library

set -euo pipefail

if [[ -t 1 ]]; then
  _RED=$'\e[31m'; _GREEN=$'\e[32m'; _YELLOW=$'\e[33m'; _BLUE=$'\e[34m'; _RESET=$'\e[0m'
else
  _RED=""; _GREEN=""; _YELLOW=""; _BLUE=""; _RESET=""
fi

log_info()  { printf '%s[INFO]%s  %s\n' "$_BLUE" "$_RESET" "$*"; }
log_ok()    { printf '%s[ OK ]%s  %s\n' "$_GREEN" "$_RESET" "$*"; }
log_warn()  { printf '%s[WARN]%s  %s\n' "$_YELLOW" "$_RESET" "$*"; }
log_fail()  { printf '%s[FAIL]%s  %s\n' "$_RED" "$_RESET" "$*" >&2; }
log_stage() { printf '\n%s======== %s ======== %s\n' "$_BLUE" "$*" "$_RESET"; }

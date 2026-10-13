#!/usr/bin/env bash
# Static checks on what the PixInsight scripts may do outside PixInsight's own
# processing (see README "Network, programs and files"):
#   - no dynamic code evaluation anywhere under pjsr/;
#   - no shell interpreter and no macOS quarantine handling;
#   - ExternalProcess only starts the programs the README lists.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
check_absent() { # pattern, message
   if grep -rnE "$1" pjsr/ --include='*.js'; then
      echo "::error::$2"; fail=1
   fi
}

check_absent '\beval[[:space:]]*\(|new[[:space:]]+Function[[:space:]]*\(' "dynamic code evaluation found in pjsr/"
check_absent '/bin/(ba|z)?sh\b|"cmd(\.exe)?"|\bpowershell\b' "a shell interpreter is started from pjsr/"
check_absent '\bxattr\b|com\.apple\.quarantine' "macOS quarantine handling found in pjsr/"
check_absent '\buname\b' "uname is no longer used; the sidecar build is picked by starting it"

# Every literal program passed to ExternalProcess.start must be documented.
allowed='^(taskkill|explorer\.exe|/usr/bin/open|xdg-open|/bin/chmod)$'
while IFS= read -r prog; do
   if ! [[ "$prog" =~ $allowed ]]; then
      echo "::error::undocumented program started from pjsr/: $prog"; fail=1
   fi
done < <(grep -rhoE '\.start\([[:space:]]*"[^"]+"' pjsr/ --include='*.js' | sed -E 's/.*"([^"]+)"/\1/' | sort -u)

# Nothing is written next to the script (the PixInsight installation).
check_absent 'scriptParentDir|scriptDir\(\)[^;]*\+[[:space:]]*"/logs' "a path under the PixInsight installation is used for writing"

[ "$fail" -eq 0 ] && echo "pjsr surface: OK"
exit "$fail"

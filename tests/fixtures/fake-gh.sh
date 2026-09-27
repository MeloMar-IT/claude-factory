#!/bin/sh
# Stand-in for the GitHub CLI. Logs every call to $FAKE_GH_LOG; "repo clone" clones $FAKE_GH_REMOTE.
# State lives next to the log: $FAKE_GH_LOG.pr (PR url once created), $FAKE_GH_LOG.checks (CI call count).
echo "gh $*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "repo view")   echo "repo: owner/repo"; echo "default branch: main" ;;
  "issue view")
    case "$*" in *"-q .title"*) echo "Add a feature" ;;
      *) printf '# #%s: Add a feature\nhttps://github.com/owner/repo/issues/%s\n\nPlease add feature.txt\n' "$3" "$3"
         if [ -n "$FAKE_GH_ISSUE_EXTRA" ]; then printf '%s\n' "$FAKE_GH_ISSUE_EXTRA"; fi ;;
    esac ;;
  "issue comment"|"pr comment") echo "--- comment on #$3:" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG"; echo "https://github.com/owner/repo/issues/$3#issuecomment-1" ;;
  "issue list")  printf '%s' "${FAKE_GH_ISSUES:-[]}" ;;
  "pr list")     printf '%s' "${FAKE_GH_PRS:-[]}" ;;
  "issue edit"|"label create") ;;
  "repo clone")  git clone -q "$FAKE_GH_REMOTE" "$4" ;;
  "pr create")   echo "--- pr body:" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG"; echo "https://github.com/owner/repo/pull/99" | tee "$FAKE_GH_LOG.pr" ;;
  "pr view")
    case "$*" in
      *reviewDecision*) echo "${FAKE_GH_REVIEW_DECISION:-}" ;;
      *reviews,comments*) printf '%s\n' "${FAKE_GH_PR_COMMENTS:---- alice:\nplease rename x}" ;;
      *number,title,body*) echo "# PR #$3 Some change" ;;
      *url*) [ -f "$FAKE_GH_LOG.pr" ] && cat "$FAKE_GH_LOG.pr" || exit 1 ;;
      *) exit 1 ;;
    esac ;;
  "pr checks")
    n=$(($(cat "$FAKE_GH_LOG.checks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_GH_LOG.checks"
    if [ -n "$FAKE_GH_CI_FAILS" ] && [ "$n" -le "$FAKE_GH_CI_FAILS" ]; then echo "test  fail  1m"; exit 1; fi
    echo "test  pass  1m" ;;
  "run list")    echo 123 ;;
  "run view")    echo "FAIL src/app.test.js: expected 2, got 3" ;;
  "pr merge")    echo "merged" ;;
  "pr checkout") git fetch -q origin "factory/pr-$3" && git checkout -q -B "factory/pr-$3" FETCH_HEAD && git branch -q --set-upstream-to="origin/factory/pr-$3" 2>/dev/null; git config "branch.factory/pr-$3.remote" origin; git config "branch.factory/pr-$3.merge" "refs/heads/factory/pr-$3" ;;
  "api "*)       case "$2" in *permission*) echo "${FAKE_GH_PERMISSION:-write}" ;; *) printf '%s' "${FAKE_GH_API:-[]}" ;; esac ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 1 ;;
esac

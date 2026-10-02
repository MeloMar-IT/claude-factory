#!/bin/sh
# Stand-in for the GitHub CLI. Logs every call to $FAKE_GH_LOG; "repo clone" clones $FAKE_GH_REMOTE.
# State lives next to the log: $FAKE_GH_LOG.pr (PR url once created), $FAKE_GH_LOG.checks (CI call count).
echo "gh $*" >> "$FAKE_GH_LOG"
if [ -n "$FAKE_GH_SLEEP" ]; then sleep "$FAKE_GH_SLEEP"; fi
# $FAKE_GH_FAIL="issue list": that call prints $FAKE_GH_FAIL_TEXT (default "boom") to stderr and fails.
if [ -n "$FAKE_GH_FAIL" ] && [ "$FAKE_GH_FAIL" = "$1 $2" ]; then printf '%s\n' "${FAKE_GH_FAIL_TEXT:-boom}" >&2; exit 1; fi
case "$1 $2" in
  "repo view")
    case "$*" in *--jq*|*nameWithOwner*) echo "repo: owner/repo"; echo "default branch: main" ;;
      *defaultBranchRef*) echo '{"defaultBranchRef":{"name":"main"}}' ;;
      *) echo "repo: owner/repo" ;;
    esac ;;
  "issue view")
    case "$*" in *"-q .title"*) echo "Add a feature" ;;
      *"--json labels --jq"*) printf '%s\n' ${FAKE_GH_ISSUE_LABELS:-} ;;
      *"--json state,labels"*) node -e 'const n=Number(process.argv[1]);const l=JSON.parse(process.env.FAKE_GH_FRESH||process.env.FAKE_GH_ISSUES||"[]");const i=l.find(x=>x.number===n)||{state:"OPEN",labels:[]};console.log(JSON.stringify({state:i.state||"OPEN",labels:i.labels||[]}))' "$3" ;;
      *"--json title,body,labels,comments"*) c=${FAKE_GH_PARENT:-}; [ -n "$c" ] || c='{"title":"Add a feature","body":"**Epic:** Updates\n\nPlease add feature.txt","labels":[{"name":"enhancement"},{"name":"Factory_go"},{"name":"Factory_working"}],"comments":[]}'; printf '%s' "$c" ;;
      *"--json comments,labels"*) c=${FAKE_GH_COMMENTS:-}; [ -n "$c" ] || c='{"comments":[]}'; printf '%s' "$c" ;;
      *"--json state"*) echo "${FAKE_GH_ISSUE_STATE:-OPEN}" ;;
      *) printf '# #%s: Add a feature\nhttps://github.com/owner/repo/issues/%s\n\nPlease add feature.txt\n' "$3" "$3"
         if [ -n "$FAKE_GH_ISSUE_EXTRA" ]; then printf '%s\n' "$FAKE_GH_ISSUE_EXTRA"; fi ;;
    esac ;;
  "issue comment"|"pr comment") echo "--- comment on #$3:" >> "$FAKE_GH_LOG"
    case "$*" in *--body-file*) cat >> "$FAKE_GH_LOG" ;;
      *) prev=""; for a in "$@"; do [ "$prev" = "--body" ] && printf '%s\n' "$a" >> "$FAKE_GH_LOG"; prev="$a"; done ;;
    esac
    echo "https://github.com/owner/repo/issues/$3#issuecomment-1" ;;
  "issue create") n=$(($(cat "$FAKE_GH_LOG.created" 2>/dev/null || echo 100) + 1)); echo "$n" > "$FAKE_GH_LOG.created"
                  echo "--- created issue: $*" >> "$FAKE_GH_LOG"; case "$*" in *--body-file*) cat >> "$FAKE_GH_LOG" ;; esac
                  echo "https://github.com/owner/repo/issues/$n" ;;
  "issue close") ;;
  "issue list")  case "$*" in *"--state closed"*) printf '%s' "${FAKE_GH_CLOSED_ISSUES:-[]}" ;; *) printf '%s' "${FAKE_GH_ISSUES:-[]}" ;; esac ;;
  "pr list")     case "$*" in *"--state merged"*) printf '%s' "${FAKE_GH_MERGED_PRS:-[]}"; exit 0 ;; esac
                 if [ -n "$FAKE_GH_PRS" ]; then printf '%s' "$FAKE_GH_PRS"; elif [ -f "$FAKE_GH_LOG.prs.json" ]; then cat "$FAKE_GH_LOG.prs.json"; else echo '[]'; fi ;;
  "issue edit") case "$*" in *--body-file*) echo "--- issue body edit: $*" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG" ;; esac ;;
  "label create") ;;
  "pr edit")     echo "--- pr edit: $*" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG" ;;
  "pr ready")    ;;
  "repo clone")  git clone -q "$FAKE_GH_REMOTE" "$4" ;;
  "pr create")   echo "--- pr body:" >> "$FAKE_GH_LOG"; cat >> "$FAKE_GH_LOG"
                 head=""; prev=""; for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; prev="$a"; done
                 # Remember created PRs (pr list returns them): number, head branch, state OPEN.
                 node -e 'const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const n=99+l.length;l.push({number:n,headRefName:process.argv[2],state:"OPEN",url:"https://github.com/owner/repo/pull/"+n});fs.writeFileSync(f,JSON.stringify(l));console.log(l.at(-1).url)' "$FAKE_GH_LOG.prs.json" "$head" | tee "$FAKE_GH_LOG.pr" ;;
  "pr view")
    case "$*" in
      *reviewDecision*) echo "${FAKE_GH_REVIEW_DECISION:-}" ;;
      *comments,reviews,commits*) printf '%s' "${FAKE_GH_PR_VIEW:-{\"comments\":[],\"reviews\":[],\"commits\":[]\}}" ;;
      *reviews,comments*) printf '%s\n' "${FAKE_GH_PR_COMMENTS:---- alice:\nplease rename x}" ;;
      *number,title,body*) echo "# PR #$3 Some change" ;;
      *url*) [ -f "$FAKE_GH_LOG.pr" ] && cat "$FAKE_GH_LOG.pr" || exit 1 ;;
      *) exit 1 ;;
    esac ;;
  "pr checks")
    n=$(($(cat "$FAKE_GH_LOG.checks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_GH_LOG.checks"
    if [ -n "$FAKE_GH_CI_FAILS" ] && [ "$n" -le "$FAKE_GH_CI_FAILS" ]; then echo "test  fail  1m"; exit 1; fi
    echo "test  pass  1m" ;;
  "run list")    case "$*" in *workflowName*) printf '%s' "${FAKE_GH_RUNS:-[]}" ;; *) echo 123 ;; esac ;;
  "run view")    echo "FAIL src/app.test.js: expected 2, got 3" ;;
  "pr merge")    echo "merged" ;;
  "pr checkout") git fetch -q origin "factory/pr-$3" && git checkout -q -B "factory/pr-$3" FETCH_HEAD && git branch -q --set-upstream-to="origin/factory/pr-$3" 2>/dev/null; git config "branch.factory/pr-$3.remote" origin; git config "branch.factory/pr-$3.merge" "refs/heads/factory/pr-$3" ;;
  "api "*)       case "$2" in user) echo "${FAKE_GH_LOGIN:-foundry-owner}" ;; *permission*) l=${2#*collaborators/}; l=${l%/permission}
                       # $FAKE_GH_READONLY: logins that only have read access
                       case " $FAKE_GH_READONLY " in *" $l "*) echo read ;; *) echo "${FAKE_GH_PERMISSION:-write}" ;; esac ;; *) printf '%s' "${FAKE_GH_API:-[]}" ;; esac ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 1 ;;
esac

Continue addressing current PR feedback, failing checks, and merge conflicts. Check remote CI/check status once; do not poll, sleep, wait, or loop for pending checks to finish. When reading GitHub review threads, request `pullRequestReview { state submittedAt commit { oid } }` and ignore comments whose review metadata is missing, whose review state is `PENDING`, or whose review has no `submittedAt`.

If you make code changes, run the relevant automated checks for the affected scope, then commit and push the task branch before returning `completed`.

{{fragment:output-validator}}

{{context:git-state}}

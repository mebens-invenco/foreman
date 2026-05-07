Continue addressing current PR feedback, failing checks, and merge conflicts. When reading GitHub review threads, request `pullRequestReview { state submittedAt commit { oid } }` and ignore comments whose review metadata is missing, whose review state is `PENDING`, or whose review has no `submittedAt`.

{{fragment:output-validator}}

{{context:git-state}}

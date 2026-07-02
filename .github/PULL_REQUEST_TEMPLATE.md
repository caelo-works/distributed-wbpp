<!-- Thanks for contributing! Keep PRs focused. -->

## What & why

Describe what this changes and the motivation.

## Validation

- [ ] `go test ./...` and `go vet ./...` pass (sidecar)
- [ ] `gofmt` clean
- [ ] CI is green

**If this can affect distribution correctness or touches `WBPPShim.js`:**
- [ ] Read [`docs/COMPATIBILITY.md`](../docs/COMPATIBILITY.md)
- [ ] The safe local fallback is preserved
- [ ] Validated a real run **distributed vs local** (bit-identical, or note the tolerance):

<!-- describe how you validated -->

## Notes

Anything reviewers should know (breaking changes, follow-ups, CHANGELOG entry).

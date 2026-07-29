# Verify release drafts before freezing public artifacts

TTcut prepares each stable GitHub Release as a Draft Release after the final
`main` commit and annotated tag are fixed. The complete signed asset set is
uploaded, downloaded again, and compared with the local artifacts before the
release becomes a Public Stable Release.

Repository release immutability is enabled before the draft is created. After
publication, the release tag and artifacts are not replaced or moved.
Substantive corrections use the next patch version instead of rewriting a
published release.

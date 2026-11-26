# Operation admission integration profile

The `admissiontest` Go build tag selects a Wails binding profile for the
representative admission vertical slice. The profile binds only
`AdmissionFacade`; it does not bind any of the nine legacy service objects.
Its reflection test fails if another exported facade method appears without
an explicit allowlist update. A second assertion names all nine legacy binding
receivers and rejects any of them in this profile.

The facade exposes a narrow operation registry:

- `create_repository`: create the database and current schema after a token
  claim.
- `migrate_repository`: migrate an existing database after a token claim.
- `discover_canvas`: discover an already-migrated repository after a token
  claim. This path does not run migrations.
- Geometry/layout operations include `set_geometry`, `set_positions`,
  `set_viewport`, `place_images`, and `unplace_images`. These are test-profile
  dispatch operations; the production UI callers are not converted yet.

`InspectRepository` and `ObserveCanvas` are read-only. They do not bootstrap a
repository. A reserve binds the canonical root, operation ID, epoch, kind, and
payload digest. A delayed dispatch must present the resulting ticket. A caller
that loses the reserve response can inspect status and seal an unstarted ID;
the tombstone rejects a late reserve or dispatch for that ID.

## Verification

Run the backend integration profile with:

```sh
nix develop --command bash -lc 'go test -tags admissiontest ./internal/db ./internal/store ./internal/service'
```

Run the isolated real-server Playwright scenario with:

```sh
nix develop .#e2e --command bash -lc 'cd frontend && bun run test:e2e:admission'
```

The E2E profile uses isolated fixtures and a server built with
`server,production,admissiontest`. It drops a successful reserve response,
reloads the browser, seals the operation, and verifies that delayed dispatch
fails. It also checks read-only schema inspection, admitted migration and
creation, gated preview requests before any rendition exists, discovery,
status, stale and duplicate calls, read-only observation, reconciliation, and
rejection of the old untagged `ImageService.DiscoverCanvas` method ID. It also
checks that a cache-only preview miss leaves the following ordinary preview
request able to generate its rendition.

## Coordinator contract and writer audit

Admission records, closure-owner IDs and tombstones, drain epochs, lease
references, and gate state share one process-local coordinator keyed by the
canonical root. Closure installation and drain-epoch allocation occur under
one mutex. Cancellation, renderer waits, database access, reconciliation, and
drain waits occur outside it. A caller timeout leaves an internal hold while
the epoch is pending. A worker owns a separate lease until renderer return,
temporary-file cleanup, publication, cache pruning, and result-file disposal.
Cleanup failure leaves a recovery hold. An unknown seal joins the current
drain and reports `drained` only after that epoch completes.

Both default and admission-test preview/thumbnail handlers use this same
coordinator for ordinary writer leases. Cache-only requests are observational:
they do not acquire a writer lease, install a closure, create cache paths, or
prune files. `InvalidateRenditions`, `RescanRepositoryContext`,
`DiscoverCanvas`, `DiscoverDirectory`, and `PurgeImages` acquire their writer
lease before taking repository or rendition locks. Revision metadata lookup
does not hold the rendition lock while it waits for the repository lock.

This is still not full production admission. The default profile continues to
bind all nine legacy services, and their mutating methods do not require a
ticket. The shared coordinator therefore supplies rendition-writer accounting,
not protection from those legacy mutations. Do not switch the production
binding profile until every mutation family and UI caller uses the facade and
all other process writers are covered.

## Remaining integration dependencies

- Existing-repository opening has no safe production migration workflow yet.
  `OpenRecent`, existing-repository `OpenFolderAt`, and `SwitchTo` use
  read-only open and fail for an older schema. `ListRecentRepos` drops entries
  that fail that read. Migration currently exists only behind the
  `admissiontest` facade. Do not add migration to observation or silently run
  `Bootstrap` in these paths. Production activation needs admitted migration
  after the complete mutation conversion.
- Preserve pending-intent and retained-graph predicates when converting graph
  and lifecycle operations. The facade must not weaken the existing eligibility
  checks.
- Preserve the durable history binding contract: an admitted batch must bind
  the operation identity and payload, and dispatch must not report terminal
  until all history writes and owned child work have finished.
- Tag/group, graph, lifecycle/import, undo/redo, recovery, metadata/settings,
  directory, and remaining history UI callers still need conversion. The
  current E2E caller invokes the facade directly; it is not a converted
  production UI caller.

## Activation boundary

The default build does not bind the facade. Its nine production service
registrations remain unchanged. Public preview and thumbnail handlers use the
shared coordinator for ordinary writer leases, but legacy mutators do not
install admission owners or carry tickets. The integration profile proves
only that the facade can be the sole bound mutation surface for this test
slice. It is not a production protection claim.

Other mutation families, their frontend callers, and HTTP/background writers
still need conversion before the production binding profile can switch. This
profile is limited to one process and a stable canonical root. It does not
prove settlement across process restart, other processes, arbitrary external
writers, or power loss.

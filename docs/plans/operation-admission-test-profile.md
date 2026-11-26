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
rejection of the old untagged `ImageService.DiscoverCanvas` method ID.

## Activation boundary

The default build does not use the facade. Its nine production service
registrations remain unchanged, and public preview and thumbnail handlers use
their compatibility path. The integration profile proves only that the
facade can be the sole bound mutation surface for this test slice. It is not a
production protection claim.

Other mutation families, their frontend callers, and HTTP/background writers
still need conversion before the production binding profile can switch. This
profile is limited to one process and a stable canonical root. It does not
prove settlement across process restart, other processes, arbitrary external
writers, or power loss.

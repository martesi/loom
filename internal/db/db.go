package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Every service RPC calls store.Bootstrap(repoPath), which calls Open here,
// opening a brand-new *sql.DB (and thus a brand-new SQLite connection) for
// the lifetime of that single call. That means "run migrations" happens on
// every single RPC rather than once per process, and when two calls land
// close together they race as independent connections against the same
// on-disk file with no busy_timeout set, producing immediate SQLITE_BUSY /
// "database is locked" errors (and, worse, a TOCTOU race inside migrate
// itself where two connections both see a migration as unapplied and both
// try to apply it, one failing with "table already exists").
//
// migrateOnce guards against that: migrate() actually runs at most once per
// on-disk DB path per process — but only the *success* result is cached and
// shared. Every other concurrent/subsequent Open for the same path waits
// for that in-flight migration pass and reuses its result once it succeeds
// — the schema is durable in the file itself, so later connections don't
// need to re-check it. busy_timeout is set as a second, independent layer
// of defense so that any remaining genuine write/write contention (e.g. two
// real concurrent mutations) blocks and retries instead of failing
// immediately.
//
// A failed migration attempt is deliberately NOT cached permanently: if it
// were (e.g. a plain sync.Once), a single transient failure — a briefly
// locked file, a flaky first connection — would poison every future Open
// call for that path for the rest of the process's life, with no recovery
// short of restarting the app. Instead, migrateResult.mu is held for the
// duration of each migrate() attempt: this keeps attempts exclusive (never
// two goroutines running migrate() concurrently for the same path, so the
// original TOCTOU race stays fixed) while still letting the *next* caller
// after a failure retry from scratch, because `done` only flips to true on
// success.
var migrateOnce sync.Map // map[string]*migrateResult

type migrateResult struct {
	mu   sync.Mutex
	done bool
}

// Open opens (creating if necessary) the SQLite database at path and brings
// it up to the latest schema version.
func Open(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	conn.SetMaxOpenConns(1)

	if err := migrateOncePerPath(path, conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return conn, nil
}

// OpenExisting opens a writable database without creating it or applying
// migrations. Callers must inspect migration state first and admit any write.
func OpenExisting(path string) (*sql.DB, error) {
	dsnURL := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	dsnURL.RawQuery = "_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	conn, err := sql.Open("sqlite", dsnURL.String())
	if err != nil {
		return nil, fmt.Errorf("open existing sqlite: %w", err)
	}
	conn.SetMaxOpenConns(1)
	if err := conn.Ping(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("open existing sqlite: %w", err)
	}
	if err := verifyMigrated(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("repository schema is not current: %w", err)
	}
	return conn, nil
}

type MigrationInspection struct {
	DatabaseExists bool     `json:"databaseExists"`
	Applied        []string `json:"applied"`
	Pending        []string `json:"pending"`
}

// InspectMigrations reads the schema ledger without creating directories,
// changing journal settings, or applying migrations.
func InspectMigrations(path string) (MigrationInspection, error) {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return MigrationInspection{}, nil
	}
	if err != nil {
		return MigrationInspection{}, err
	}
	if !info.Mode().IsRegular() {
		return MigrationInspection{}, fmt.Errorf("database path is not a regular file")
	}
	dsnURL := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	dsnURL.RawQuery = "mode=ro&_pragma=busy_timeout(5000)"
	conn, err := sql.Open("sqlite", dsnURL.String())
	if err != nil {
		return MigrationInspection{}, fmt.Errorf("open migration inspection read-only: %w", err)
	}
	defer conn.Close()
	if err := conn.Ping(); err != nil {
		return MigrationInspection{}, fmt.Errorf("inspect existing database: %w", err)
	}
	status := MigrationInspection{DatabaseExists: true}
	var ledgerExists bool
	if err := conn.QueryRow(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')`).Scan(&ledgerExists); err != nil {
		return MigrationInspection{}, err
	}
	appliedSet := make(map[string]struct{})
	if ledgerExists {
		rows, err := conn.Query(`SELECT version FROM schema_migrations`)
		if err != nil {
			return MigrationInspection{}, err
		}
		for rows.Next() {
			var version string
			if err := rows.Scan(&version); err != nil {
				rows.Close()
				return MigrationInspection{}, err
			}
			appliedSet[version] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return MigrationInspection{}, err
		}
		if err := rows.Close(); err != nil {
			return MigrationInspection{}, err
		}
	}
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return MigrationInspection{}, err
	}
	for _, entry := range entries {
		if _, ok := appliedSet[entry.Name()]; ok {
			status.Applied = append(status.Applied, entry.Name())
		} else {
			status.Pending = append(status.Pending, entry.Name())
		}
	}
	return status, nil
}

// OpenExistingReadOnly opens an existing database without creating the file,
// changing journal settings, or applying migrations. Observation paths use it
// so recovery cannot mutate a repository while backend settlement is unknown.
func OpenExistingReadOnly(path string, immutable bool) (*sql.DB, error) {
	dsnURL := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	dsnURL.RawQuery = "mode=ro&_pragma=busy_timeout(5000)"
	if immutable {
		dsnURL.RawQuery += "&immutable=1"
	}
	dsn := dsnURL.String()
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite read-only: %w", err)
	}
	conn.SetMaxOpenConns(1)
	if err := conn.Ping(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("open existing sqlite database read-only: %w", err)
	}
	if err := verifyMigrated(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("repository database is not ready for read-only observation: %w", err)
	}
	return conn, nil
}

func verifyMigrated(conn *sql.DB) error {
	rows, err := conn.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		return err
	}
	applied := make(map[string]bool)
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		applied[version] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !applied[entry.Name()] {
			return fmt.Errorf("missing migration %s", entry.Name())
		}
	}
	return nil
}

// migrateOncePerPath runs migrate(conn) at most once per (cleaned) path for
// the lifetime of this process, on success. Concurrent/later callers for
// the same path block on res.mu and then reuse the successful result
// instead of re-running migrate on their own, independent connection. If
// the attempt fails, done stays false, so the very next caller to acquire
// res.mu (whether that's a goroutine that was already queued up behind a
// concurrent failing attempt, or a fresh call arriving later) gets a
// genuine retry rather than the stale cached error — while res.mu still
// guarantees only one goroutine ever runs migrate() for this path at a
// time.
func migrateOncePerPath(path string, conn *sql.DB) error {
	key := filepath.Clean(path)
	v, _ := migrateOnce.LoadOrStore(key, &migrateResult{})
	res := v.(*migrateResult)

	res.mu.Lock()
	defer res.mu.Unlock()

	if res.done {
		return nil
	}

	if err := migrate(conn); err != nil {
		return err
	}
	res.done = true
	return nil
}

func migrate(conn *sql.DB) error {
	if _, err := conn.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)`); err != nil {
		return err
	}

	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		var applied int
		if err := conn.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, name).Scan(&applied); err != nil {
			return err
		}
		if applied > 0 {
			continue
		}

		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}

		tx, err := conn.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(sqlBytes)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, name); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

package store

import "database/sql"

// GetSetting returns the value stored under key in the repo-scoped settings
// table, or "" if the key has never been set — same "unset means zero value,
// no error" convention as UndoCursor (see oplog.go), since a not-yet-set
// setting is an expected, ordinary state rather than a failure.
func (r *Repo) GetSetting(key string) (string, error) {
	var v string
	err := r.DB.QueryRow(`SELECT value FROM settings WHERE scope = 'repo' AND key = ?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return v, nil
}

// SetSetting upserts key's value in the repo-scoped settings table.
func (r *Repo) SetSetting(key, value string) error {
	_, err := r.DB.Exec(`
		INSERT INTO settings (scope, key, value) VALUES ('repo', ?, ?)
		ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
		key, value)
	return err
}

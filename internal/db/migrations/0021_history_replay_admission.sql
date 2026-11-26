-- A reserved binding owns the repository history until its terminal receipt
-- is reconciled. These triggers also make metadata and membership-only writes
-- visible to selection tokens; service admission fences prevent such writes
-- while a reservation is active.
CREATE TRIGGER history_revision_group_metadata_update AFTER UPDATE OF name,kind,cover_image_id ON groups BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_group_membership_update AFTER UPDATE OF group_id ON images
WHEN OLD.group_id IS NOT NEW.group_id BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_group_insert AFTER INSERT ON groups BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;
CREATE TRIGGER history_revision_group_delete AFTER DELETE ON groups BEGIN
    UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE scope='repo' AND key='history_revision';
END;

-- 0020 could mistake the two halves of a legitimate replacement replay for
-- an ID collision. Repair only exact, fully fingerprinted matching records.
-- Any non-matching or ambiguous evidence stays in inspection.
UPDATE request_id_registry AS r
SET state=CASE WHEN h.state='complete' AND j.completed_at IS NOT NULL THEN 'complete'
               WHEN h.state='pending' OR j.completed_at IS NULL THEN 'reserved'
               ELSE 'inspection' END,
    family='history', repo_path=h.repo_path, direction=h.direction,
    parameter_hash=h.request_hash,
    expected_cursor=CASE WHEN h.direction='undo' THEN h.selected_seq ELSE h.selected_seq-1 END,
    selected_seq=h.selected_seq, selected_kind=h.selected_kind,
    selected_forward=h.selected_forward, selected_inverse=h.selected_inverse,
    selected_created_at=h.selected_created_at,
    result_json=COALESCE(h.result_json,j.result_json),
    conflict_reason=CASE WHEN h.state='pending' OR j.completed_at IS NULL
                         THEN 'legacy replacement replay requires recovery'
                         ELSE '' END
FROM history_replay_requests h
JOIN replacement_replay_journal j ON j.request_id=h.request_id
WHERE r.request_id=h.request_id AND r.state='inspection'
  AND h.repo_path=j.repo_path
  AND h.direction=j.action
  AND h.direction IN ('undo','redo')
  AND h.request_hash=j.request_hash
  AND h.selected_seq=j.history_seq
  AND h.selected_kind=j.history_kind
  AND h.selected_forward=j.history_forward
  AND h.selected_inverse=j.history_inverse
  AND h.selected_created_at=j.history_created_at
  AND (CASE WHEN h.direction='undo' THEN h.selected_seq ELSE h.selected_seq-1 END)=j.expected_cursor
  AND json_valid(h.selected_forward) AND json_valid(h.selected_inverse)
  AND json_extract(h.selected_forward,'$.kind')='representation'
  AND json_extract(h.selected_inverse,'$.kind')='representation'
  AND length(COALESCE(json_extract(h.selected_forward,'$.payload.currentFingerprint'),''))>0
  AND length(COALESCE(json_extract(h.selected_forward,'$.payload.incomingFingerprint'),''))>0
  AND length(COALESCE(json_extract(h.selected_inverse,'$.payload.currentFingerprint'),''))>0
  AND length(COALESCE(json_extract(h.selected_inverse,'$.payload.incomingFingerprint'),''))>0
  AND length(j.current_fingerprint)>0 AND length(j.incoming_fingerprint)>0;

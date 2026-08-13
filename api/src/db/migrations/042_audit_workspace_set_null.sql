-- 042: the audit trail must outlive its own subject.
--
-- public_audit_log.workspace_id was declared ON DELETE CASCADE, so deleting a
-- workspace also erased every audit row attributed to it — the subject of the
-- record could destroy the record. That is exactly backwards for an audit log.
-- Every other foreign key on this table is already ON DELETE SET NULL (app_id,
-- user_id), so the row can survive as an attributable-but-orphaned entry; bring
-- workspace_id into line. Found by the final-submission audit sweep.
--
-- The constraint name is Postgres's default for a column-level FK
-- (<table>_<column>_fkey); DROP ... IF EXISTS keeps this idempotent.
ALTER TABLE public_audit_log
  DROP CONSTRAINT IF EXISTS public_audit_log_workspace_id_fkey;

ALTER TABLE public_audit_log
  ADD CONSTRAINT public_audit_log_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

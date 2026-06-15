-- Fix RLS infinite recursion on contact_custom_fields.
-- The original SELECT policy (00002) self-joined contact_custom_fields INSIDE its
-- own USING clause → Postgres recursed evaluating the policy → 500 on any read
-- (the inbox contact panel's custom-fields fetch). The "manage" (ALL) policy
-- already covers SELECT correctly with a plain contacts-membership check; replace
-- the broken SELECT policy with the same non-recursive form.
DROP POLICY IF EXISTS "Users can view contact custom fields" ON contact_custom_fields;
CREATE POLICY "Users can view contact custom fields"
  ON contact_custom_fields FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_custom_fields.contact_id
        AND is_workspace_member(c.workspace_id)
    )
  );

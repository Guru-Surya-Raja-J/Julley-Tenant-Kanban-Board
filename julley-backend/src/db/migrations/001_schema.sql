-- Tenant Flow schema.
-- Hierarchy: organizations -> tenants -> boards -> columns -> tasks.
-- Isolation is enforced by composite foreign keys and row-level security, so it
-- holds even if application code forgets a WHERE clause.

CREATE TYPE membership_role AS ENUM ('org_admin', 'tenant_admin', 'member');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');

-- ---------------------------------------------------------------------------
-- Control plane
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  version          integer NOT NULL DEFAULT 1,
  -- Per-tenant event counter. Incrementing it locks the row until commit, which
  -- makes event sequence numbers gap-free and ordered by commit.
  event_seq        bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  password_hash  text NOT NULL,
  color          text NOT NULL DEFAULT '#3f6f5e',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  tenant_id        uuid,
  role             membership_role NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- The composite key guarantees the tenant belongs to the stated organization.
  FOREIGN KEY (organization_id, tenant_id)
    REFERENCES tenants (organization_id, id) ON DELETE CASCADE,
  -- org_admin is org-wide; every other role belongs to exactly one tenant.
  CONSTRAINT memberships_role_scope CHECK ((role = 'org_admin') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX memberships_org_admin_key
  ON memberships (user_id, organization_id) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX memberships_tenant_key
  ON memberships (user_id, tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX memberships_org_idx ON memberships (organization_id);
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);

-- ---------------------------------------------------------------------------
-- Data plane: every table carries tenant_id
-- ---------------------------------------------------------------------------

CREATE TABLE boards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description     text NOT NULL DEFAULT '',
  version         integer NOT NULL DEFAULT 1,
  field_versions  jsonb NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE columns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  board_id        uuid NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Fractional rank key. COLLATE "C" sorts bytewise, as the key generator does.
  position        text COLLATE "C",
  version         integer NOT NULL DEFAULT 1,
  field_versions  jsonb NOT NULL DEFAULT '{}',
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, board_id, id),
  FOREIGN KEY (tenant_id, board_id) REFERENCES boards (tenant_id, id) ON DELETE CASCADE,
  -- Live rows always have a rank; soft-deleted rows give theirs up (NULLs never clash).
  CONSTRAINT columns_live_has_position CHECK ((deleted_at IS NULL) = (position IS NOT NULL)),
  CONSTRAINT columns_board_position_key UNIQUE (board_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  board_id        uuid NOT NULL,
  column_id       uuid NOT NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description     text NOT NULL DEFAULT '',
  priority        task_priority NOT NULL DEFAULT 'medium',
  assignee_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  due_date        date,
  position        text COLLATE "C",
  version         integer NOT NULL DEFAULT 1,
  -- {"title": {"v": 7, "by": "<user id>"}}: who last changed each field, and when.
  field_versions  jsonb NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- A task cannot reference a column in another board or tenant.
  FOREIGN KEY (tenant_id, board_id, column_id)
    REFERENCES columns (tenant_id, board_id, id) ON DELETE CASCADE,
  CONSTRAINT tasks_live_has_position CHECK ((deleted_at IS NULL) = (position IS NOT NULL)),
  -- Deferrable so a rebalance can rewrite a whole column in one transaction.
  CONSTRAINT tasks_column_position_key UNIQUE (column_id, position) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX tasks_board_live_idx ON tasks (tenant_id, board_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX boards_tenant_idx ON boards (tenant_id);

CREATE TABLE activity_logs (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  seq           bigint NOT NULL,
  actor_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  -- No foreign key: history must outlive the board it describes.
  board_id      uuid,
  client_op_id  text,
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, seq)
);
CREATE UNIQUE INDEX activity_logs_idempotency_key
  ON activity_logs (tenant_id, actor_id, client_op_id) WHERE client_op_id IS NOT NULL;
CREATE INDEX activity_logs_entity_idx ON activity_logs (tenant_id, entity_id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- These return NULL when unset, and comparing with NULL matches nothing: fail closed.
CREATE FUNCTION app_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_current_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION app_current_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- The current tenant's organization. SECURITY DEFINER so that the memberships
-- policy can use it without recursing through the tenants policy.
CREATE FUNCTION app_current_tenant_org() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT organization_id FROM tenants WHERE id = app_current_tenant() $$;

ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY boards_tenant ON boards
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY columns_tenant ON columns
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tasks_tenant ON tasks
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY activity_logs_tenant ON activity_logs
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- A user always sees their own memberships. Seeing or changing other people's
-- requires the org or tenant scope, which the server only sets for admins.
CREATE POLICY memberships_read ON memberships FOR SELECT USING (
  user_id = app_current_user()
  OR organization_id = app_current_org()
  OR tenant_id = app_current_tenant()
  -- Org admins are effectively members of every tenant, e.g. as task assignees.
  OR (tenant_id IS NULL AND organization_id = app_current_tenant_org())
);
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (
  organization_id = app_current_org() OR tenant_id = app_current_tenant()
);
CREATE POLICY memberships_update ON memberships FOR UPDATE USING (
  organization_id = app_current_org() OR tenant_id = app_current_tenant()
);
CREATE POLICY memberships_delete ON memberships FOR DELETE USING (
  organization_id = app_current_org() OR tenant_id = app_current_tenant()
);

CREATE POLICY tenants_read ON tenants FOR SELECT USING (
  id = app_current_tenant()
  OR organization_id = app_current_org()
  OR EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = app_current_user()
      AND m.organization_id = tenants.organization_id
      AND (m.tenant_id IS NULL OR m.tenant_id = tenants.id)
  )
);
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (organization_id = app_current_org());
CREATE POLICY tenants_update ON tenants FOR UPDATE USING (
  id = app_current_tenant() OR organization_id = app_current_org()
);
CREATE POLICY tenants_delete ON tenants FOR DELETE USING (organization_id = app_current_org());

CREATE POLICY organizations_read ON organizations FOR SELECT USING (
  id = app_current_org()
  OR EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = app_current_user() AND m.organization_id = organizations.id
  )
);
CREATE POLICY organizations_insert ON organizations FOR INSERT WITH CHECK (id = app_current_org());
CREATE POLICY organizations_update ON organizations FOR UPDATE USING (id = app_current_org());
CREATE POLICY organizations_delete ON organizations FOR DELETE USING (id = app_current_org());

-- ---------------------------------------------------------------------------
-- Least-privilege grants for the API role (created by the migration runner)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, tenants, memberships, boards, columns, tasks TO kanban_app;
GRANT SELECT, INSERT, UPDATE ON users TO kanban_app;
-- The audit trail is append-only for the application.
GRANT SELECT, INSERT ON activity_logs TO kanban_app;
GRANT USAGE ON SEQUENCE activity_logs_id_seq TO kanban_app;

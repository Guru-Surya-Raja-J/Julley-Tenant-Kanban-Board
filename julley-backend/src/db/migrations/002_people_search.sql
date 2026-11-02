-- People who can be added to the current scope, for the "add member" search.
--
-- Search only reaches people already in the organization, so no one can browse
-- users of other organizations. SECURITY DEFINER because a tenant admin's RLS scope
-- deliberately can't read memberships in sibling tenants. This function reveals only
-- matching names and emails from the organization, not who belongs where.
--
-- In org scope it excludes existing org admins. In tenant scope it also excludes
-- that tenant's members. With no scope set, it returns nothing.
CREATE FUNCTION app_search_org_people(p_pattern text, p_limit integer)
  RETURNS TABLE (id uuid, name text, email text, color text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  WITH scope AS (SELECT COALESCE(app_current_org(), app_current_tenant_org()) AS org_id)
  SELECT u.id, u.name, u.email, u.color
  FROM users u, scope
  WHERE (u.name ILIKE '%' || p_pattern || '%' OR u.email ILIKE '%' || p_pattern || '%')
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = u.id AND m.organization_id = scope.org_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = u.id AND m.organization_id = scope.org_id
        AND (m.tenant_id IS NULL OR m.tenant_id = app_current_tenant())
    )
  -- Names and emails starting with the text come before matches further in.
  ORDER BY (u.name ILIKE p_pattern || '%' OR u.email ILIKE p_pattern || '%') DESC, u.name
  LIMIT p_limit
$$;

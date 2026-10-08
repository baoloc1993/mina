-- Dev chỉ khai CREATE TABLE; CLI tự chèn cột hệ thống, RLS tenant_isolation, grant, trigger giờ server, publication.
CREATE TABLE IF NOT EXISTS app_vn_app_private_a_notes (
  id    uuid PRIMARY KEY,
  title text NOT NULL DEFAULT ''
);

// Đếm "ngày dùng" cho H3 (vòng 7): MỖI LẦN shell mở một mini app thì xin app token — `issue-app-token` ghi `app_opens_daily`.
// Không có mini app thật nào tự gọi `auth.getAppToken` nên nếu shell không làm thì số ngày dùng luôn bằng 0 (bug-hunter vòng 7).
// Fire-and-forget: offline / 429 / lỗi gì cũng KHÔNG được làm chậm hoặc hỏng việc mở app.
export function noteAppOpen(getToken: (appId: string) => Promise<unknown>, appId: string): void {
  void Promise.resolve()
    .then(() => getToken(appId))
    .catch(() => undefined);
}

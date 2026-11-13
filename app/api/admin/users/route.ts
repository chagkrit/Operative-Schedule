// Admin-only allowlist API. All rules, validation and status mapping live in
// app/lib/admin-users-api.ts (tested with an in-memory store); this file only binds the Blob store.
import { handleAdminUsers } from "../../../lib/admin-users-api";
import { userStore } from "../../../lib/user-store";

export async function GET(request: Request) {
  return handleAdminUsers(request, "GET", userStore);
}

export async function POST(request: Request) {
  return handleAdminUsers(request, "POST", userStore);
}

export async function PATCH(request: Request) {
  return handleAdminUsers(request, "PATCH", userStore);
}

export async function DELETE(request: Request) {
  return handleAdminUsers(request, "DELETE", userStore);
}

export const dynamic = "force-dynamic";

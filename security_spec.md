# Security Specification & Test Payloads

## 1. Data Invariants
- Users can only read and write to documents within their own user hierarchy (`/users/{userId}/**`), where `request.auth != null && request.auth.uid == userId`.
- All PII (`users/{userId}` email, `contacts` phone/name) is strictly private to the owner (`isOwner(userId)`), never exposed via blanket `isSignedIn()` reads.
- Every document in `contacts`, `lists`, `campaigns`, and `reports` enforces `ownerId == request.auth.uid` on create and `incoming().ownerId == existing().ownerId` on update.
- Parent `/users/{userId}` existence is checked or owned synchronously (`isOwner(userId)`), and every document ID matches `^[a-zA-Z0-9_\-]+$` with length <= 128.
- Strict schema checks (`keys().hasAll(...)` + `keys().hasOnly(...)` + type & `.size()` bounds + `affectedKeys().hasOnly(...)` on update) block shadow fields and oversized payloads.
- Default deny prevents unauthorized collection or document group read/write.

## 2. The Dirty Dozen Attack Payloads
1. **Cross-Tenant User Profile Read**: User B reading `/users/{userA}` without ownership -> `PERMISSION_DENIED`.
2. **Cross-Tenant User Profile Write**: User B overwriting `/users/{userA}` with `{ id: "userA", email: "b@x.com", createdAt: "..." }` -> `PERMISSION_DENIED`.
3. **Cross-Tenant Contact Creation**: User B injecting contacts into `/users/{userA}/contacts/{contact1}` -> `PERMISSION_DENIED`.
4. **OwnerId Impersonation**: User A creating `/users/{userA}/contacts/c_1` with `{ id: "c_1", ownerId: "userB", name: "Eve", phone: "14155551234", optedIn: true, createdAt: "..." }` -> `PERMISSION_DENIED`.
5. **Cross-Tenant Contact Read**: User B listing `/users/{userA}/contacts` -> `PERMISSION_DENIED`.
6. **Cross-Tenant Contact Delete**: User B deleting `/users/{userA}/contacts/{contact1}` -> `PERMISSION_DENIED`.
7. **Unauthenticated Read**: Anonymous request (`auth == null`) reading `/users/{userA}/contacts` -> `PERMISSION_DENIED`.
8. **Unauthenticated Write**: Anonymous request (`auth == null`) writing `/users/{userA}/campaigns/{camp1}` -> `PERMISSION_DENIED`.
9. **Junk Character Document ID Injection**: User A writing `/users/{userA}/contacts/` + 200-char ID or invalid symbols `../bad` -> `PERMISSION_DENIED`.
10. **Immutable Field / Owner Hijack Update**: User A updating `/users/{userA}/contacts/c_1` attempting to mutate `createdAt` or `ownerId` -> `PERMISSION_DENIED`.
11. **Shadow Field Injection**: User A creating `/users/{userA}` with extra root field `{ ..., isAdmin: true }` -> `PERMISSION_DENIED`.
12. **Array Exhaustion / Unbounded List Attack**: User A writing a Contact with `listIds` containing 51 items or non-string first element `[123]` -> `PERMISSION_DENIED`.

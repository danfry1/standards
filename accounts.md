# Maintainer account standards

A standard for the accounts behind the code: GitHub, the package registries,
and the email inboxes that can reset them. Every pipeline in these standards
ultimately trusts a person's login. The threat model is a phished password, an
intercepted SMS code, a forgotten token on an old laptop, an OAuth app nobody
remembers granting, and an inbox that can reset everything else.

The posture: **phishing-resistant sign-in everywhere, no standing credentials,
and recovery paths as strong as the accounts they recover.**

Legend: ✅ do · ❌ avoid.

---

## Core rules

### 1. Passkeys as the preferred second factor; no SMS

Use a passkey or security key as the **preferred** 2FA method on GitHub, npm,
crates.io's login provider (GitHub), and every email account in the recovery
chain. Keep a second method registered as a backup where the service allows
one - a second passkey or key, or an authenticator app. Remove SMS: a number
can be ported to an attacker's SIM.

A synced passkey (in a password manager or the platform keychain) is its own
backup across devices. Review the list of registered passkeys and remove any
you cannot account for.

### 2. Recovery codes offline, outside the password manager

Recovery codes are the way back in when every device is gone. Store them
somewhere a compromise of the password manager does not reach: printed, or on
an encrypted drive at home.

### 3. The recovery email is the master key

Whoever controls the inbox that can reset your GitHub or registry account
controls the account. Give that inbox the same protection as the account (a
passkey, current recovery options), and never publish it as a contact address.

### 4. No standing credentials on your machine

With every release on trusted publishing, the laptop does not need to stay
logged in to any registry.

```bash
npm logout      # ✅ after a one-off bootstrap publish or an approval
cargo logout
npm token list  # ✅ should be empty
```

On npm, set 2FA to **auth-and-writes** (2FA on login *and* on every write), and
set each package to "require 2FA and disallow tokens".

### 5. No personal access tokens; one key per GitHub App

Automation that needs to act across repositories uses a GitHub App
([GitHub Actions](github-actions.md#12-cross-repo-writes-use-a-github-app-token-never-a-pat)):

- Give the App the minimum permissions (for a tap bumper: Contents read/write,
  Metadata read) and install it only on the repositories it writes to.
- Keep **one** private key. When rotating, verify the new key works before
  deleting the old one: sign an App JWT locally and call `GET /app`.
- Delete the downloaded `.pem` once it is stored as a secret.

Delete expired and unused personal access tokens; there should be none.

### 6. Review what can act as you

- **OAuth apps** and **GitHub Apps** with access to your account: revoke what
  you no longer use. An App with Contents write on a repository whose tags
  publish is, in effect, a publisher.
- **SSH keys**: one per device, named after it; remove any you cannot match to
  a device by fingerprint (`ssh-keygen -lf ~/.ssh/<key>.pub`).
- **Sessions**: sign out of unknown sessions.
- **Dormant integrations**: delete the account rather than just rotating its
  key; an unused service with a valid key is pure risk.

### 7. Email: noreply for commits, your own domain for contact

- Commit with the GitHub noreply address (`ID+user@users.noreply.github.com`)
  and enable **"Keep my email addresses private"** and **"Block command line
  pushes that expose my email"**. The privacy setting also makes commits made
  with the merge button use the noreply address.
- Publish a **contact address on a domain you own** (`dan@`, `security@`), with
  SPF, DKIM and DMARC. Move DMARC to `p=reject` once legitimate mail passes; for
  a domain that sends nothing else, that can be days, not weeks.
- Keep old addresses as **verified secondary emails** forever: removing one
  unlinks every past commit made with it from your profile.
- Registry profiles (npm, crates.io) use the domain address too.

---

## Enforcement

These are account settings, so most are checked by hand. Run through this list
once a quarter:

- [ ] Preferred 2FA is a passkey on GitHub, npm and each recovery inbox; no SMS
- [ ] Recovery codes stored offline and still valid
- [ ] `npm token list` empty; no `~/.npmrc` or `~/.cargo/credentials.toml` token
- [ ] No personal access tokens; each GitHub App has one key
- [ ] OAuth apps, GitHub Apps, SSH keys and sessions reviewed
- [ ] No personal or recovery address in any `SECURITY.md` or package metadata
- [ ] DMARC at `p=reject` on the contact domain

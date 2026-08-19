/**
 * On-device Matrix Sentinel — cybersecurity specialist.
 * Answers any cyber security topic with practical, lawful guidance.
 * No exploit payloads / weaponized PoCs.
 */

function pack(topic, body) {
  return `**${topic}**\n\n${body}`;
}

const KB = [
  {
    keys: ["phish", "spear", "email", "smish", "vish"],
    reply: (q) =>
      pack(
        "Phishing & social engineering",
        `You asked: “${q.slice(0, 180)}”\n\nHow it works: attackers impersonate a trusted party to steal credentials, MFA tokens, or trigger a payload. Common channels: email, SMS, Teams/Slack, voice.\n\nDefend:\n• Verify sender domain + lookalike characters (rn vs m).\n• Never follow unexpected “reset / invoice / VPN” links — type the portal yourself.\n• Enforce phishing-resistant MFA (FIDO2 / passkeys), not SMS.\n• Banner external mail, strip active content, sandbox attachments.\n• Train with realistic simulations; measure report-rate, not click-shame.\n\nIf someone already clicked: isolate the endpoint, reset tokens/sessions (not just password), hunt mailbox rules + OAuth consents, check MFA registration changes.`
      ),
  },
  {
    keys: ["ransom", "encrypt", "locker", "double extort"],
    reply: (q) =>
      pack(
        "Ransomware response",
        `Context: ${q.slice(0, 160)}\n\nPriorities (NIST IR style):\n1. Contain — isolate affected VLANs/hosts, disable lateral admin, freeze backups from being overwritten.\n2. Identify family / note (hashes, mutexes, onion leak site) via intel, not by running samples on production.\n3. Preserve volatile evidence if you have IR capability.\n4. Restore from known-good, offline, tested backups. Paying is a business/legal decision and does not guarantee recovery.\n5. Hunt persistence: GPO, scheduled tasks, new domain admins, cloud keys.\n\nPrevention: immutable backups, least privilege, EDR with tamper protection, patch internet-facing VPN/RDP, MFA everywhere, application allowlisting on servers.`
      ),
  },
  {
    keys: ["owasp", "xss", "sqli", "csrf", "ssrf", "injection", "idor"],
    reply: (q) =>
      pack(
        "Application security",
        `Question: ${q.slice(0, 180)}\n\nPractical AppSec:\n• Injection — parameterized queries / ORM, never string-build SQL or OS commands.\n• XSS — context-aware encoding, CSP, HttpOnly+Secure+SameSite cookies.\n• CSRF — synchronizer tokens or SameSite=Lax/Strict + no state-changing GET.\n• Broken access control / IDOR — authorize on every object, not just login.\n• SSRF — allowlists for outbound, block link-local/metadata IPs, no raw user URLs to fetchers.\n• Secrets — vaults, short-lived creds, never in git.\n\nI can review architecture, threat models, secure coding patterns, and detection ideas. I will not write exploit payloads or weaponized PoCs.`
      ),
  },
  {
    keys: ["siem", "soc", "splunk", "sentinel", "alert", "detection"],
    reply: (q) =>
      pack(
        "SOC / detection engineering",
        `${q.slice(0, 160)}\n\nBuild detections around attacker behaviors (MITRE ATT&CK), not single IOCs:\n• Identity: impossible travel, MFA fatigue, new inbox rules, OAuth app grants.\n• Endpoint: LOLBins (powershell -enc, rundll32, mshta), LSASS access, service creation.\n• Network: beaconing jitter, DNS tunneling length entropy, rare egress ports.\n\nTune: suppress known-good, enrich with asset criticality, page on high-fidelity chains. Document runbooks so 03:00 responders do the same thing every time.`
      ),
  },
  {
    keys: ["iam", "mfa", "sso", "zero trust", "ztna", "identity", "rbac"],
    reply: (q) =>
      pack(
        "Identity, MFA & Zero Trust",
        `${q.slice(0, 160)}\n\nZero Trust is “never trust, always verify” for users, devices, and workloads:\n• Strong identity: phishing-resistant MFA, SSO, just-in-time admin, PAM.\n• Device trust: posture (disk encrypt, EDR healthy) before access.\n• Least privilege + continuous authz, not a one-time VPN.\n• Micro-segment / ZTNA instead of flat networks.\n• Log every grant; review stale accounts weekly.\n\nPasswords alone are not a control. Prefer passkeys / hardware keys for admins.`
      ),
  },
  {
    keys: ["malware", "trojan", "rat", "c2", "sandbox", "yara"],
    reply: (q) =>
      pack(
        "Malware analysis (defensive)",
        `${q.slice(0, 160)}\n\nSafe workflow:\n• Isolate sample (air-gapped or dedicated lab VM, no shared clipboards/drives).\n• Static: hashes, strings, imports, packer signs, YARA.\n• Dynamic: procmon/procmon-like traces, network to a sinkhole, snapshot revert.\n• Map capabilities to ATT&CK; extract IOCs for blocklists.\n\nI can help interpret behaviors, write high-level YARA ideas, and IR steps. I will not generate malware or attack tooling.`
      ),
  },
  {
    keys: ["cloud", "aws", "azure", "gcp", "s3", "iam policy", "bucket"],
    reply: (q) =>
      pack(
        "Cloud security",
        `${q.slice(0, 160)}\n\nHigh-yield cloud controls:\n• Org SCPs / Azure Policy / org constraints — deny public storage, require encryption, block root keys.\n• Identity first: no long-lived access keys; IRSA / workload identity; break-glass in a vault.\n• Network: private endpoints, no 0.0.0.0/0 on admin ports, WAF on public apps.\n• Data: default-deny buckets, object lock for backups, CMEK where required.\n• Detect: CloudTrail / Activity logs immutable to a separate account; alert on DisableLogging, new IAM *, public ACL.`
      ),
  },
  {
    keys: ["forensic", "incident", "ir ", "playbook", "contain"],
    reply: (q) =>
      pack(
        "Incident response",
        `${q.slice(0, 160)}\n\nPICERL: Prepare → Identify → Contain → Eradicate → Recover → Lessons.\n\nFirst hour:\n• Name an incident commander. Start a timeline. Legal/comms if customer data.\n• Snapshot, don’t wipe. Collect volatile (memory, netstat) if skilled.\n• Contain surgically (account disable, host isolate) — avoid tipping sophisticated actors too early if you need scoping.\n• Rotate secrets that the blast radius could touch.\n\nWrite a blameless post-incident review with detection gaps and owners.`
      ),
  },
  {
    keys: ["network", "firewall", "ids", "ips", "vpn", "dns"],
    reply: (q) =>
      pack(
        "Network defense",
        `${q.slice(0, 160)}\n\n• Default-deny firewalls; egress filtering (most orgs only filter inbound).\n• Segment OT / PCI / admin jump hosts.\n• DNS logging + sinkhole known-bad; consider protective DNS.\n• TLS inspection only with a clear privacy/legal policy and pinned-app exceptions.\n• VPN is not Zero Trust — pair with device posture and per-app access.\n• Detect: new listeners, unusual east-west, beacon intervals.`
      ),
  },
  {
    keys: ["crypto", "tls", "certificate", "pki", "hash", "aes"],
    reply: (q) =>
      pack(
        "Cryptography (applied)",
        `${q.slice(0, 160)}\n\nUse well-reviewed libraries, never homemade crypto.\n• TLS 1.2+ (prefer 1.3), modern ciphers, HSTS, cert transparency.\n• Passwords: Argon2id / scrypt / bcrypt with unique salts — not SHA-256 “encryption”.\n• Data at rest: AES-GCM or XChaCha20-Poly1305; manage keys in HSM/KMS.\n• Signatures: Ed25519 or ECDSA P-256; hash with SHA-256+.\n• Rotate, escrow recovery keys, and monitor cert expiry.`
      ),
  },
  {
    keys: ["linux", "harden", "cis", "windows", "patch"],
    reply: (q) =>
      pack(
        "System hardening",
        `${q.slice(0, 160)}\n\nCIS-style baseline:\n• Patch cadence + emergency channel for internet-facing CVEs.\n• Disable unused services; no SMBv1 / Telnet / unauth Redis.\n• SSH: keys only, no root login, AllowUsers, fail2ban or equivalent.\n• Auditd / Sysmon, central logs, file integrity on critical paths.\n• Disk encryption, secure boot where possible, EDR.\n• Unique local admin passwords (LAPS).`
      ),
  },
  {
    keys: ["gdpr", "hipaa", "pci", "iso 27001", "nist", "compliance"],
    reply: (q) =>
      pack(
        "Governance & compliance",
        `${q.slice(0, 160)}\n\nMap controls to a framework (NIST CSF / ISO 27001 / CIS 18) then prove them with evidence.\nPrivacy: data inventory, lawful basis, minimization, DLP, breach clocks (e.g. GDPR 72h).\nPCI: never store track2/CVV; segment CDE.\nThis is not legal advice — pair with counsel for regulated programs.`
      ),
  },
  {
    keys: ["pentest", "red team", "bug bounty", "oscp", "offensive"],
    reply: (q) =>
      pack(
        "Offensive security (authorized only)",
        `${q.slice(0, 160)}\n\nI can discuss methodology: recon → mapping → authorized testing → reporting, scoping, rules of engagement, and how blue teams detect the same techniques.\n\nI will not write exploits, exploit PoCs, malware, or attack systems. For labs, use legal ranges (HackTheBox, local VMs you own) and document findings as a defender would.`
      ),
  },
];

export function matrixReply(userText, attachments = []) {
  const q = (userText || "").trim();
  const low = q.toLowerCase();

  if (!q && attachments.length) {
    return pack(
      "Attachment review",
      `I received ${attachments.length} file(s) in this chat. Describe what you want (IOC extraction ideas, phishing screenshot review, architecture diagram walkthrough). Paste text, headers, or hashes here — keep live credentials out of chat.`
    );
  }

  if (!q) {
    return "Ask me anything about cybersecurity: IR, AppSec, cloud, IAM, malware (defensive), compliance, hardening, SOC detections.";
  }

  const blocked = /(write|give|drop).{0,40}(exploit|poc|payload|malware|ransomware|c2 server)/i;
  if (blocked.test(q) && /(code|script|binary|ready to run)/i.test(q)) {
    return pack(
      "Guardrail",
      "I can explain the vulnerability class, impact, and how to detect/fix it, but I will not write exploits, malware, or attack payloads. Tell me the defensive or learning angle you need."
    );
  }

  for (const row of KB) {
    if (row.keys.some((k) => low.includes(k))) return row.reply(q);
  }

  return pack(
    "Matrix Sentinel — cyber briefing",
    `You said: “${q.slice(0, 280)}”\n\nI am Matrix Sentinel, specialized in cybersecurity. I can go deep on:\n• Threats: phishing, ransomware, malware, insider, supply chain\n• Defense: Zero Trust, IAM, EDR, SIEM, hardening, backups\n• Build: secure SDLC, AppSec, cloud (AWS/Azure/GCP), crypto hygiene\n• Respond: IR playbooks, forensics process, comms, lessons learned\n• Govern: NIST CSF, ISO 27001, PCI, privacy basics\n\nAsk a sharper question (environment, asset, symptom, goal) and I will give a concrete plan, checklist, or architecture. I stay on the lawful / defensive side of the line.`
  );
}

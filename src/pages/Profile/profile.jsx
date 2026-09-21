import React, { useEffect, useRef, useState } from "react";
import { ref, get, update } from "firebase/database";
import { database } from "../../firebase/config"; // ⚠️ adjust this path to match where you save this file
import "./profile.css";

/* ---------------- Inline SVG icons ---------------- */
const IconKey = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

const IconEye = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconEyeOff = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const IconCheck = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
       strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export default function Profile() {
  const [user, setUser] = useState(null);
  const [userKey, setUserKey] = useState(null); // Firebase key — needed to update the password
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* ---- Change password modal state ---- */
  const [showPwModal, setShowPwModal] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwErrors, setPwErrors] = useState({});
  const [pwVerified, setPwVerified] = useState(false); // step 1 passed?
  const [showPwCurrent, setShowPwCurrent] = useState(false);
  const [showPwNew, setShowPwNew] = useState(false);
  const [showPwConfirm, setShowPwConfirm] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  /* ---- Toast state ---- */
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const showToast = (type, message) => {
    setToast({ type, message });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  /* Load the logged-in user's profile from the database */
  useEffect(() => {
    const fetchProfile = async () => {
      try {
        /* The Login page saves the userid in localStorage */
        const stored = JSON.parse(localStorage.getItem("dpirsUser") || "{}");
        const userid = stored.userid || localStorage.getItem("userid");

        if (!userid) {
          setError("You are not signed in.");
          return;
        }

        let profile = null;
        let key = null;

        /* Direct lookup — userid is the Firebase key of the user */
        const snap = await get(ref(database, `users/${userid}`));

        if (snap.exists()) {
          profile = snap.val();
          key = userid;
        } else {
          /* Fallback: search for a user that stores its own "userid" field */
          const all = await get(ref(database, "users"));
          if (all.exists()) {
            const entry = Object.entries(all.val()).find(
              ([, u]) => u?.userid === userid
            );
            if (entry) {
              key = entry[0]; // real Firebase key
              profile = entry[1];
            }
          }
        }

        if (profile) {
          setUser(profile);
          setUserKey(key);
        } else {
          setError("Profile not found.");
        }
      } catch (err) {
        setError("Failed to load profile. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    fetchProfile();
  }, []);

  /* Close the modal with the Escape key */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setShowPwModal(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Clear toast timer on unmount */
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /* ---------------- CHANGE PASSWORD ---------------- */

  const openPwModal = () => {
    setPwCurrent("");
    setPwNew("");
    setPwConfirm("");
    setPwErrors({});
    setPwVerified(false);
    setShowPwCurrent(false);
    setShowPwNew(false);
    setShowPwConfirm(false);
    setShowPwModal(true);
  };

  const closePwModal = () => {
    if (savingPw) return;
    setShowPwModal(false);
  };

  const handlePwChange = (e) => {
    const { name, value } = e.target;
    if (name === "current") setPwCurrent(value);
    else if (name === "new") setPwNew(value);
    else if (name === "confirm") setPwConfirm(value);

    if (pwErrors[name]) setPwErrors((prev) => ({ ...prev, [name]: "" }));
  };

  /* STEP 1 — verify the current password.
     NOTE: your DB stores passwords as plain text, so we compare directly.
     (In production, hash passwords and compare hashes instead.) */
  const verifyCurrentPassword = () => {
    if (!pwCurrent) {
      setPwErrors({ current: "Please enter your current password." });
      return;
    }

    const stored = user?.password;
    if (stored === undefined || stored === null) {
      setPwErrors({ current: "No password is stored for this account." });
      return;
    }

    if (pwCurrent === stored) {
      setPwVerified(true); // reveals the new-password section below
      setPwErrors({});
    } else {
      setPwErrors({ current: "Incorrect current password. Please try again." });
    }
  };

  /* STEP 2 — save the new password */
  const handleChangePassword = async (e) => {
    e.preventDefault();

    /* safety: if step 1 was skipped somehow, verify first */
    if (!pwVerified) {
      verifyCurrentPassword();
      return;
    }

    const err = {};
    if (!pwNew) err.new = "New password is required.";
    else if (pwNew.length < 6) err.new = "Password must be at least 6 characters.";

    if (!pwConfirm) err.confirm = "Please confirm the new password.";
    else if (pwNew !== pwConfirm) err.confirm = "Passwords do not match.";

    setPwErrors(err);
    if (Object.keys(err).length > 0) return;

    if (!userKey) {
      showToast("error", "Cannot update password: user record not found.");
      return;
    }

    setSavingPw(true);
    try {
      await update(ref(database, `users/${userKey}`), {
        password: pwNew,
        updatedAt: Date.now(),
      });
      showToast("success", "Your password has been updated successfully.");
      setShowPwModal(false);
      /* keep the local profile in sync so re-verifying works with the new password */
      setUser((prev) => ({ ...prev, password: pwNew }));
    } catch (err2) {
      showToast("error", `Failed to update password: ${err2.message}`);
    } finally {
      setSavingPw(false);
    }
  };

  /* ---------------- helpers ---------------- */
  const initials = (name = "") =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";

  const formatDate = (ts) =>
    typeof ts === "number"
      ? new Date(ts).toLocaleDateString(undefined, {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "—";

  const roleClass = (role) => {
    const r = (role || "").toLowerCase();
    if (r === "admin") return "pf-role pf-role-admin";
    if (r === "receptionist") return "pf-role pf-role-receptionist";
    if (r === "principal") return "pf-role pf-role-principal";
    return "pf-role";
  };

  /* ---------------- render ---------------- */
  if (loading) {
    return (
      <div className="pf-page">
        <div className="pf-mini-card">
          <div className="pf-loading">
            <div className="pf-spinner" />
            <p>Loading profile…</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pf-page">
        <div className="pf-error">
          <span className="pf-error-icon">!</span>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="pf-page">
      <div className="pf-card">
        {/* Avatar + Name + Role */}
        <div className="pf-head">
          <div className="pf-avatar">{initials(user.name)}</div>
          <h1 className="pf-name">{user.name ?? "—"}</h1>
          <span className={roleClass(user.role)}>{user.role ?? "User"}</span>
        </div>

        <div className="pf-divider" />

        {/* Details */}
        <div className="pf-body">
          <div className="pf-row">
            <span className="pf-label">Username</span>
            <span className="pf-value">{user.username ?? "—"}</span>
          </div>

          <div className="pf-row">
            <span className="pf-label">Email</span>
            <span className="pf-value">{user.email ?? "—"}</span>
          </div>

          <div className="pf-row">
            <span className="pf-label">Member Since</span>
            <span className="pf-value">{formatDate(user.createdAt)}</span>
          </div>
        </div>

        {/* Action */}
        <div className="pf-foot">
          <button className="pf-btn pf-btn-primary" onClick={openPwModal}>
            <IconKey />
            Change Password
          </button>
        </div>
      </div>

      {/* ---------------- CHANGE PASSWORD MODAL ---------------- */}
      {showPwModal && (
        <div
          className="pf-modal-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && closePwModal()}
        >
          <div className="pf-modal">
            <div className="pf-modal-head">
              <div className="pf-modal-head-text">
                <h2>Change Password</h2>
                <span className="pf-modal-step">
                  {pwVerified
                    ? "Step 2 of 2 · Set a new password"
                    : "Step 1 of 2 · Verify current password"}
                </span>
              </div>
              <button className="pf-modal-close" onClick={closePwModal} aria-label="Close">
                ✕
              </button>
            </div>

            <form onSubmit={handleChangePassword} noValidate>
              <div className="pf-modal-body">
                {/* STEP 1 — current password */}
                <div className="pf-field">
                  <label htmlFor="pf-pw-current">Current Password *</label>
                  <div className="pf-password-wrap">
                    <input
                      id="pf-pw-current"
                      name="current"
                      autoFocus
                      type={showPwCurrent ? "text" : "password"}
                      className={`pf-input ${pwErrors.current ? "pf-input-error" : ""}`}
                      placeholder="Enter your current password"
                      value={pwCurrent}
                      onChange={handlePwChange}
                      disabled={pwVerified}
                    />
                    <button
                      type="button"
                      className="pf-eye"
                      onClick={() => setShowPwCurrent((v) => !v)}
                      aria-label={showPwCurrent ? "Hide password" : "Show password"}
                    >
                      {showPwCurrent ? <IconEyeOff /> : <IconEye />}
                    </button>
                  </div>
                  {pwErrors.current && (
                    <span className="pf-field-error">{pwErrors.current}</span>
                  )}
                </div>

                {/* STEP 2 — revealed ONLY after the current password is verified */}
                {pwVerified && (
                  <div className="pf-pw-new">
                    <span className="pf-verified">
                      <IconCheck />
                      Current password verified
                    </span>

                    <div className="pf-field">
                      <label htmlFor="pf-pw-new">New Password *</label>
                      <div className="pf-password-wrap">
                        <input
                          id="pf-pw-new"
                          name="new"
                          autoFocus
                          type={showPwNew ? "text" : "password"}
                          className={`pf-input ${pwErrors.new ? "pf-input-error" : ""}`}
                          placeholder="Minimum 6 characters"
                          value={pwNew}
                          onChange={handlePwChange}
                        />
                        <button
                          type="button"
                          className="pf-eye"
                          onClick={() => setShowPwNew((v) => !v)}
                          aria-label={showPwNew ? "Hide password" : "Show password"}
                        >
                          {showPwNew ? <IconEyeOff /> : <IconEye />}
                        </button>
                      </div>
                      {pwErrors.new && <span className="pf-field-error">{pwErrors.new}</span>}
                    </div>

                    <div className="pf-field">
                      <label htmlFor="pf-pw-confirm">Confirm New Password *</label>
                      <div className="pf-password-wrap">
                        <input
                          id="pf-pw-confirm"
                          name="confirm"
                          type={showPwConfirm ? "text" : "password"}
                          className={`pf-input ${pwErrors.confirm ? "pf-input-error" : ""}`}
                          placeholder="Re-enter the new password"
                          value={pwConfirm}
                          onChange={handlePwChange}
                        />
                        <button
                          type="button"
                          className="pf-eye"
                          onClick={() => setShowPwConfirm((v) => !v)}
                          aria-label={showPwConfirm ? "Hide password" : "Show password"}
                        >
                          {showPwConfirm ? <IconEyeOff /> : <IconEye />}
                        </button>
                      </div>
                      {pwErrors.confirm && (
                        <span className="pf-field-error">{pwErrors.confirm}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="pf-modal-foot">
                <button
                  type="button"
                  className="pf-btn pf-btn-ghost"
                  onClick={closePwModal}
                  disabled={savingPw}
                >
                  Cancel
                </button>

                {pwVerified ? (
                  <button type="submit" className="pf-btn pf-btn-primary" disabled={savingPw}>
                    {savingPw && <span className="pf-btn-spinner" />}
                    Update Password
                  </button>
                ) : (
                  <button
                    type="button"
                    className="pf-btn pf-btn-primary"
                    onClick={verifyCurrentPassword}
                  >
                    Verify &amp; Continue
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---------------- TOAST ---------------- */}
      {toast && (
        <div className={`pf-toast pf-toast-${toast.type}`}>
          <span className="pf-toast-dot" />
          {toast.message}
        </div>
      )}
    </div>
  );
}
import React, { useEffect, useRef, useState } from "react";
import { ref, push, onValue, update, remove } from "firebase/database";
import { database } from "../../../firebase/config";
import "./ManageUser.css";

/* Quick-select role options (you can still type any custom role) */
const QUICK_ROLES = ["Admin", "Receptionist", "Principal"];

const EMPTY_FORM = {
  name: "",
  username: "",
  email: "",
  role: "",
  password: "",
};

/* ---------------- Inline SVG icons (no extra libraries needed) ---------------- */
const IconPlus = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
       strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const IconEdit = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const IconTrash = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" /><path d="M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
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

/* Key icon — the "change password" action in each table row */
const IconKey = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

const IconCheck = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
       strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export default function UserManage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  /* ---- Add / Edit form state ---- */
  const [showForm, setShowForm] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  /* ---- Delete confirmation state ---- */
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  /* ---- Change password modal state ---- */
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordUser, setPasswordUser] = useState(null); // user being changed
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwErrors, setPwErrors] = useState({});
  const [pwVerified, setPwVerified] = useState(false); // step 1 passed?
  const [showPwCurrent, setShowPwCurrent] = useState(false);
  const [showPwNew, setShowPwNew] = useState(false);
  const [showPwConfirm, setShowPwConfirm] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  /* ---- Toast state ---- */
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const showToast = (type, message) => {
    setToast({ type, message });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  /* ------------------------------------------------------------------ */
  /*  REALTIME DATABASE — real-time listener on "users" node             */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    const usersRef = ref(database, "users");

    const unsubscribe = onValue(
      usersRef,
      (snapshot) => {
        const data = snapshot.val() || {};
        const list = Object.entries(data)
          .map(([id, value]) => ({ id, ...value }))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        setUsers(list);
        setLoading(false);
      },
      (error) => {
        showToast("error", `Failed to load users: ${error.message}`);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  /* Close ALL modals with the Escape key */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        setShowForm(false);
        setShowDeleteModal(false);
        setShowPasswordModal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Clear toast timer on unmount */
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /* ----------------------- FORM HANDLERS ----------------------- */

  const openAddForm = () => {
    setFormData(EMPTY_FORM);
    setErrors({});
    setIsEditing(false);
    setEditingId(null);
    setShowPassword(false);
    setShowForm(true);
  };

  const openEditForm = (user) => {
    setFormData({
      name: user.name ?? "",
      username: user.username ?? "",
      email: user.email ?? "",
      role: user.role ?? "",
      password: "", // never pre-fill the password
    });
    setErrors({});
    setIsEditing(true);
    setEditingId(user.id);
    setShowPassword(false);
    setShowForm(true);
  };

  const closeForm = () => {
    if (saving) return;
    setShowForm(false);
    setErrors({});
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: "" }));
  };

  const validateForm = () => {
    const err = {};
    const name = formData.name.trim();
    const username = formData.username.trim();
    const email = formData.email.trim().toLowerCase();
    const role = formData.role.trim();
    const password = formData.password;

    if (!name) err.name = "Name is required.";

    if (!username) err.username = "Username is required.";
    else if (!/^[a-zA-Z0-9._-]+$/.test(username))
      err.username = "Only letters, numbers, dots, dashes and underscores.";
    else if (users.some((u) => u.username?.toLowerCase() === username && u.id !== editingId))
      err.username = "This username is already taken.";

    if (!email) err.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      err.email = "Enter a valid email address.";
    else if (users.some((u) => u.email?.toLowerCase() === email && u.id !== editingId))
      err.email = "This email is already registered.";

    if (!role) err.role = "Role is required.";

    if (!isEditing) {
      if (!password) err.password = "Password is required.";
      else if (password.length < 6) err.password = "Password must be at least 6 characters.";
    } else if (password && password.length < 6) {
      err.password = "Password must be at least 6 characters.";
    }

    return err;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = validateForm();
    setErrors(err);
    if (Object.keys(err).length > 0) return;

    setSaving(true);
    try {
      if (isEditing) {
        const payload = {
          name: formData.name.trim(),
          username: formData.username.trim(),
          email: formData.email.trim().toLowerCase(),
          role: formData.role.trim(),
          updatedAt: Date.now(),
        };
        // Only overwrite the password if a new one was typed
        if (formData.password) payload.password = formData.password;

        await update(ref(database, `users/${editingId}`), payload);
        showToast("success", "User updated successfully.");
      } else {
        await push(ref(database, "users"), {
          name: formData.name.trim(),
          username: formData.username.trim(),
          email: formData.email.trim().toLowerCase(),
          role: formData.role.trim(),
          password: formData.password,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        showToast("success", "User added successfully.");
      }
      setShowForm(false);
      setFormData(EMPTY_FORM);
      setEditingId(null);
    } catch (error) {
      showToast("error", `Something went wrong: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  /* ----------------------- DELETE HANDLERS ----------------------- */

  const requestDelete = (user) => {
    setUserToDelete(user);
    setShowDeleteModal(true);
  };

  const handleConfirmDelete = async () => {
    if (!userToDelete) return;
    setDeleting(true);
    try {
      await remove(ref(database, `users/${userToDelete.id}`));
      showToast("success", `"${userToDelete.name}" was deleted.`);
      setShowDeleteModal(false);
      setUserToDelete(null);
    } catch (error) {
      showToast("error", `Failed to delete user: ${error.message}`);
    } finally {
      setDeleting(false);
    }
  };

  /* ----------------------- CHANGE PASSWORD ----------------------- */

  const openPasswordModal = (user) => {
    setPasswordUser(user);
    setPwCurrent("");
    setPwNew("");
    setPwConfirm("");
    setPwErrors({});
    setPwVerified(false);
    setShowPwCurrent(false);
    setShowPwNew(false);
    setShowPwConfirm(false);
    setShowPasswordModal(true);
  };

  const closePasswordModal = () => {
    if (savingPassword) return;
    setShowPasswordModal(false);
    setPasswordUser(null);
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
     (In production you should hash passwords — then compare hashes here.) */
  const handleVerifyCurrentPassword = () => {
    if (!pwCurrent) {
      setPwErrors({ current: "Please enter the current password." });
      return;
    }

    /* read the freshest record from the live list */
    const fresh = users.find((u) => u.id === passwordUser?.id) || passwordUser;
    const stored = fresh?.password;

    if (stored === undefined || stored === null) {
      setPwErrors({ current: "No password is stored for this user yet." });
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
      handleVerifyCurrentPassword();
      return;
    }

    const err = {};
    if (!pwNew) err.new = "New password is required.";
    else if (pwNew.length < 6) err.new = "Password must be at least 6 characters.";

    if (!pwConfirm) err.confirm = "Please confirm the new password.";
    else if (pwNew !== pwConfirm) err.confirm = "Passwords do not match.";

    setPwErrors(err);
    if (Object.keys(err).length > 0) return;

    setSavingPassword(true);
    try {
      await update(ref(database, `users/${passwordUser.id}`), {
        password: pwNew,
        updatedAt: Date.now(),
      });
      showToast("success", `Password updated for "${passwordUser.name}".`);
      setShowPasswordModal(false);
      setPasswordUser(null);
    } catch (error) {
      showToast("error", `Failed to update password: ${error.message}`);
    } finally {
      setSavingPassword(false);
    }
  };

  /* ----------------------- SMALL HELPERS ----------------------- */

  const roleBadgeClass = (role) => {
    const r = (role || "").toLowerCase();
    if (r === "admin") return "um-badge um-badge-admin";
    if (r === "receptionist") return "um-badge um-badge-receptionist";
    if (r === "principal") return "um-badge um-badge-principal";
    return "um-badge";
  };

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
          month: "short",
          year: "numeric",
        })
      : "—";

  const countRole = (role) =>
    users.filter((u) => (u.role || "").toLowerCase() === role).length;

  /* ============================ RENDER ============================ */
  return (
    <div className="um-page">
      {/* HEADER */}
      <header className="um-header">
        <div>
          
        </div>
        <button className="um-btn um-btn-primary" onClick={openAddForm}>
          <IconPlus />
          Add User
        </button>
      </header>

      {/* STATS */}
      <section className="um-stats">
        <div className="um-stat">
          <span className="um-stat-value">{users.length}</span>
          <span className="um-stat-label">Total Users</span>
        </div>
        <div className="um-stat">
          <span className="um-stat-value">{countRole("admin")}</span>
          <span className="um-stat-label">Admins</span>
        </div>
        <div className="um-stat">
          <span className="um-stat-value">{countRole("receptionist")}</span>
          <span className="um-stat-label">Receptionists</span>
        </div>
        <div className="um-stat">
          <span className="um-stat-value">{countRole("principal")}</span>
          <span className="um-stat-label">Principals</span>
        </div>
      </section>

      {/* USERS TABLE */}
      <section className="um-card">
        <div className="um-card-head">
          <h2 className="um-card-title">All Users</h2>
          <span className="um-count-badge">
            {users.length} user{users.length === 1 ? "" : "s"}
          </span>
        </div>

        {loading ? (
          <div className="um-loading">
            <div className="um-spinner" />
            <p>Loading users…</p>
          </div>
        ) : users.length === 0 ? (
          <div className="um-empty">
            <div className="um-empty-icon">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor"
                   strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <h3>No users yet</h3>
            <p>Click the “Add User” button above to create your first user.</p>
          </div>
        ) : (
          <div className="um-table-wrap">
            <table className="um-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Added On</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="um-user-cell">
                        <div className="um-avatar">{initials(user.name)}</div>
                        <span className="um-user-name">{user.name}</span>
                      </div>
                    </td>
                    <td>{user.username}</td>
                    <td className="um-email">{user.email}</td>
                    <td>
                      <span className={roleBadgeClass(user.role)}>{user.role}</span>
                    </td>
                    <td className="um-date">{formatDate(user.createdAt)}</td>
                    <td>
                      <div className="um-actions">
                        <button className="um-action-btn um-action-edit" title="Edit user"
                                onClick={() => openEditForm(user)}>
                          <IconEdit />
                        </button>
                        <button className="um-action-btn um-action-pass" title="Change password"
                                onClick={() => openPasswordModal(user)}>
                          <IconKey />
                        </button>
                        <button className="um-action-btn um-action-delete" title="Delete user"
                                onClick={() => requestDelete(user)}>
                          <IconTrash />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ADD / EDIT MODAL */}
      {showForm && (
        <div
          className="um-modal-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && closeForm()}
        >
          <div className="um-modal">
            <div className="um-modal-head">
              <h2>{isEditing ? "Edit User" : "Add New User"}</h2>
              <button className="um-close" onClick={closeForm} aria-label="Close">✕</button>
            </div>

            <form onSubmit={handleSubmit} noValidate>
              <div className="um-form-body">
                <div className="um-field">
                  <label htmlFor="um-name">Full Name *</label>
                  <input
                    id="um-name" type="text" name="name" autoFocus
                    className={`um-input ${errors.name ? "um-input-error" : ""}`}
                    placeholder="e.g. Sarah Johnson"
                    value={formData.name} onChange={handleChange}
                  />
                  {errors.name && <span className="um-error">{errors.name}</span>}
                </div>

                <div className="um-field">
                  <label htmlFor="um-username">Username *</label>
                  <input
                    id="um-username" type="text" name="username"
                    className={`um-input ${errors.username ? "um-input-error" : ""}`}
                    placeholder="e.g. sarah.j"
                    value={formData.username} onChange={handleChange}
                  />
                  {errors.username && <span className="um-error">{errors.username}</span>}
                </div>

                <div className="um-field um-field-full">
                  <label htmlFor="um-email">Email *</label>
                  <input
                    id="um-email" type="email" name="email"
                    className={`um-input ${errors.email ? "um-input-error" : ""}`}
                    placeholder="e.g. sarah@school.com"
                    value={formData.email} onChange={handleChange}
                  />
                  {errors.email && <span className="um-error">{errors.email}</span>}
                </div>

                <div className="um-field um-field-full">
                  <label htmlFor="um-role">Role *</label>
                  <input
                    id="um-role" type="text" name="role"
                    className={`um-input ${errors.role ? "um-input-error" : ""}`}
                    placeholder="Type a role or click a quick option below"
                    value={formData.role} onChange={handleChange}
                  />
                  <div className="um-quick-roles">
                    {QUICK_ROLES.map((r) => (
                      <button
                        type="button" key={r}
                        className={`um-chip ${formData.role.toLowerCase() === r.toLowerCase() ? "um-chip-active" : ""}`}
                        onClick={() => setFormData((prev) => ({ ...prev, role: r }))}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  {errors.role && <span className="um-error">{errors.role}</span>}
                </div>

                <div className="um-field um-field-full">
                  <label htmlFor="um-password">
                    Password {isEditing ? "(leave blank to keep the current one)" : "*"}
                  </label>
                  <div className="um-password-wrap">
                    <input
                      id="um-password"
                      type={showPassword ? "text" : "password"}
                      name="password"
                      className={`um-input ${errors.password ? "um-input-error" : ""}`}
                      placeholder={isEditing ? "Enter a new password only if you want to change it" : "Minimum 6 characters"}
                      value={formData.password} onChange={handleChange}
                    />
                    <button
                      type="button" className="um-eye"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <IconEyeOff /> : <IconEye />}
                    </button>
                  </div>
                  {errors.password && <span className="um-error">{errors.password}</span>}
                </div>
              </div>

              <div className="um-modal-foot">
                <button type="button" className="um-btn um-btn-ghost" onClick={closeForm} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="um-btn um-btn-primary" disabled={saving}>
                  {saving && <span className="um-btn-spinner" />}
                  {isEditing ? "Save Changes" : "Add User"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CHANGE PASSWORD MODAL */}
      {showPasswordModal && passwordUser && (
        <div
          className="um-modal-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && closePasswordModal()}
        >
          <div className="um-modal um-cp-modal">
            <div className="um-modal-head">
              <div className="um-cp-head-text">
                <h2>Change Password</h2>
                <span className="um-cp-step">
                  {pwVerified ? "Step 2 of 2 · Set a new password" : "Step 1 of 2 · Verify current password"}
                </span>
              </div>
              <button className="um-close" onClick={closePasswordModal} aria-label="Close">✕</button>
            </div>

            <form onSubmit={handleChangePassword} noValidate>
              <div className="um-cp-body">
                {/* user whose password is being changed */}
                <div className="um-cp-user">
                  <div className="um-avatar">{initials(passwordUser.name)}</div>
                  <div className="um-cp-user-info">
                    <span className="um-cp-name">{passwordUser.name}</span>
                    <span className="um-cp-mail">{passwordUser.email}</span>
                  </div>
                </div>

                {/* STEP 1 — current password */}
                <div className="um-field">
                  <label htmlFor="um-pw-current">Current Password *</label>
                  <div className="um-password-wrap">
                    <input
                      id="um-pw-current" name="current" autoFocus
                      type={showPwCurrent ? "text" : "password"}
                      className={`um-input ${pwErrors.current ? "um-input-error" : ""}`}
                      placeholder="Enter the current password"
                      value={pwCurrent} onChange={handlePwChange}
                      disabled={pwVerified}
                    />
                    <button
                      type="button" className="um-eye"
                      onClick={() => setShowPwCurrent((v) => !v)}
                      aria-label={showPwCurrent ? "Hide password" : "Show password"}
                    >
                      {showPwCurrent ? <IconEyeOff /> : <IconEye />}
                    </button>
                  </div>
                  {pwErrors.current && <span className="um-error">{pwErrors.current}</span>}
                </div>

                {/* STEP 2 — revealed ONLY after the current password is verified */}
                {pwVerified && (
                  <div className="um-cp-new">
                    <span className="um-cp-verified">
                      <IconCheck />
                      Current password verified
                    </span>

                    <div className="um-field">
                      <label htmlFor="um-pw-new">New Password *</label>
                      <div className="um-password-wrap">
                        <input
                          id="um-pw-new" name="new" autoFocus
                          type={showPwNew ? "text" : "password"}
                          className={`um-input ${pwErrors.new ? "um-input-error" : ""}`}
                          placeholder="Minimum 6 characters"
                          value={pwNew} onChange={handlePwChange}
                        />
                        <button
                          type="button" className="um-eye"
                          onClick={() => setShowPwNew((v) => !v)}
                          aria-label={showPwNew ? "Hide password" : "Show password"}
                        >
                          {showPwNew ? <IconEyeOff /> : <IconEye />}
                        </button>
                      </div>
                      {pwErrors.new && <span className="um-error">{pwErrors.new}</span>}
                    </div>

                    <div className="um-field">
                      <label htmlFor="um-pw-confirm">Confirm New Password *</label>
                      <div className="um-password-wrap">
                        <input
                          id="um-pw-confirm" name="confirm"
                          type={showPwConfirm ? "text" : "password"}
                          className={`um-input ${pwErrors.confirm ? "um-input-error" : ""}`}
                          placeholder="Re-enter the new password"
                          value={pwConfirm} onChange={handlePwChange}
                        />
                        <button
                          type="button" className="um-eye"
                          onClick={() => setShowPwConfirm((v) => !v)}
                          aria-label={showPwConfirm ? "Hide password" : "Show password"}
                        >
                          {showPwConfirm ? <IconEyeOff /> : <IconEye />}
                        </button>
                      </div>
                      {pwErrors.confirm && <span className="um-error">{pwErrors.confirm}</span>}
                    </div>
                  </div>
                )}
              </div>

              <div className="um-modal-foot">
                <button type="button" className="um-btn um-btn-ghost"
                        onClick={closePasswordModal} disabled={savingPassword}>
                  Cancel
                </button>

                {pwVerified ? (
                  <button type="submit" className="um-btn um-btn-primary" disabled={savingPassword}>
                    {savingPassword && <span className="um-btn-spinner" />}
                    Update Password
                  </button>
                ) : (
                  <button type="button" className="um-btn um-btn-primary"
                          onClick={handleVerifyCurrentPassword}>
                    Verify &amp; Continue
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {showDeleteModal && userToDelete && (
        <div
          className="um-modal-overlay"
          onMouseDown={(e) => e.target === e.currentTarget && !deleting && setShowDeleteModal(false)}
        >
          <div className="um-modal um-modal-sm">
            <div className="um-confirm-icon"><IconTrash /></div>
            <h2>Delete this user?</h2>
            <p>
              You are about to permanently delete{" "}
              <strong>{userToDelete.name}</strong> ({userToDelete.email}).
              <br />This action cannot be undone.
            </p>
            <div className="um-modal-foot">
              <button className="um-btn um-btn-ghost" onClick={() => setShowDeleteModal(false)} disabled={deleting}>
                Cancel
              </button>
              <button className="um-btn um-btn-danger" onClick={handleConfirmDelete} disabled={deleting}>
                {deleting && <span className="um-btn-spinner" />}
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOAST NOTIFICATION */}
      {toast && (
        <div className={`um-toast um-toast-${toast.type}`}>
          <span className="um-toast-dot" />
          {toast.message}
        </div>
      )}
    </div>
  );
}
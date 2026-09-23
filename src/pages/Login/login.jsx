import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ref, get } from "firebase/database";
import { database } from "../../firebase/config";
import PassPortIcon from "../../assets/images/passport-icon.webp";
import "./login.css";

const IconUser = () => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c.8-4.2 3.5-6.5 8-6.5s7.2 2.3 8 6.5" />
  </svg>
);

const IconLock = () => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

const IconEye = () => (
  <svg
    viewBox="0 0 24 24"
    width="19"
    height="19"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconEyeOff = () => (
  <svg
    viewBox="0 0 24 24"
    width="19"
    height="19"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 3l18 18" />
    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
    <path d="M9.9 4.2A10.6 10.6 0 0 1 12 4c6.5 0 10 8 10 8a17.5 17.5 0 0 1-3.1 4.4" />
    <path d="M6.2 6.2C3.4 8.2 2 12 2 12s3.5 8 10 8c1.8 0 3.4-.5 4.8-1.2" />
  </svg>
);

const IconArrow = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </svg>
);

export default function Login() {
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e) => {
    e.preventDefault();

    setError("");

    const cleanUsername = username.trim();

    if (!cleanUsername || !password) {
      setError("Please enter your username and password.");
      return;
    }

    setLoading(true);

    try {
      const usersRef = ref(database, "users");
      const snapshot = await get(usersRef);

      if (!snapshot.exists()) {
        setError("Unable to sign in. No users are available.");
        setLoading(false);
        return;
      }

      const users = snapshot.val();

      let authenticatedUser = null;

      Object.entries(users).forEach(([firebaseId, user]) => {
        if (
          !authenticatedUser &&
          user?.username?.toLowerCase() === cleanUsername.toLowerCase() &&
          user?.password === password
        ) {
          authenticatedUser = {
            firebaseId,
            ...user,
          };
        }
      });

      if (!authenticatedUser) {
        setError("Invalid username or password.");
        setLoading(false);
        return;
      }

      /*
       * Store only the information required by the application.
       */
      localStorage.setItem(
        "dpirsUser",
        JSON.stringify({
          username: authenticatedUser.username,
          name: authenticatedUser.name,
          role: authenticatedUser.role,
          userid: authenticatedUser.userid || authenticatedUser.firebaseId,
        })
      );

      /*
       * Also store individual values for easy access
       * from existing components.
       */
      localStorage.setItem("username", authenticatedUser.username);
      localStorage.setItem("name", authenticatedUser.name);
      localStorage.setItem("role", authenticatedUser.role);
      localStorage.setItem(
        "userid",
        authenticatedUser.userid || authenticatedUser.firebaseId
      );

      /*
       * Login successful.
       */
      navigate("/dashboard", { replace: true });
    } catch (err) {
      console.error("Login error:", err);
      setError("Unable to connect to the server. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dp-login-page">
      <div className="dp-login-background">
        <div className="dp-login-shape dp-login-shape-one" />
        <div className="dp-login-shape dp-login-shape-two" />
      </div>

      <main className="dp-login-container">
        <section className="dp-login-card">

          {/* BRANDING */}
<div className="dp-login-brand">

  <img
    src={PassPortIcon}
    alt="DPIRS PassPort"
    className="dp-login-passport-icon"
  />

  <div className="dp-login-brand-text">
    <h1>DPIRS PassPort</h1>
  </div>

</div>

          

          {/* LOGIN FORM */}
          <form onSubmit={handleLogin} className="dp-login-form">

            {/* USERNAME */}
            <div className="dp-login-field">
              <label htmlFor="dpirs-username">
                Username
              </label>

              <div className="dp-login-input-wrap">
                <span className="dp-login-input-icon">
                  <IconUser />
                </span>

                <input
                  id="dpirs-username"
                  type="text"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setError("");
                  }}
                  autoComplete="username"
                  autoFocus
                  disabled={loading}
                />
              </div>
            </div>

            {/* PASSWORD */}
            <div className="dp-login-field">
              <label htmlFor="dpirs-password">
                Password
              </label>

              <div className="dp-login-input-wrap">
                <span className="dp-login-input-icon">
                  <IconLock />
                </span>

                <input
                  id="dpirs-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  autoComplete="current-password"
                  disabled={loading}
                />

                <button
                  type="button"
                  className="dp-login-password-toggle"
                  onClick={() => setShowPassword((prev) => !prev)}
                  disabled={loading}
                  aria-label={
                    showPassword
                      ? "Hide password"
                      : "Show password"
                  }
                >
                  {showPassword ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
            </div>

            {/* ERROR */}
            {error && (
              <div className="dp-login-error">
                <span className="dp-login-error-icon">!</span>
                <span>{error}</span>
              </div>
            )}

            {/* SUBMIT */}
            <button
              type="submit"
              className="dp-login-submit"
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="dp-login-spinner" />
                  Signing in...
                </>
              ) : (
                <>
                  Sign in
                  <IconArrow />
                </>
              )}
            </button>
          </form>

          

        </section>

        <p className="dp-login-copyright">
          © {new Date().getFullYear()} De Paul International Residential School, Mysore.
        </p>
      </main>
    </div>
  );
}
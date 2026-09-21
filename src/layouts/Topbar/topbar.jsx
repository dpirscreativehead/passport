import { Link, useLocation } from "react-router-dom";
import "./topbar.css";

const IconCalendar = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4.5" width="18" height="17" rx="2.5" />
        <path d="M16 2.5v4" />
        <path d="M8 2.5v4" />
        <path d="M3 10.5h18" />
    </svg>
);

const IconBell = () => (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
);

const IconChevron = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
    </svg>
);

function Topbar() {
    const location = useLocation();

    const userName = localStorage.getItem("name") || "User";
    const role = localStorage.getItem("role") || "Member";

    const initials =
        userName
            .trim()
            .split(/\s+/)
            .map((word) => word[0])
            .filter(Boolean)
            .slice(0, 2)
            .join("")
            .toUpperCase() || "U";

    const pageTitles = {
        "/student": "Student",
        "/staff": "Staff",
        "/reports": "Reports",
        "/preferences": "Preferences",
        "/profile": "Profile",
    };

    const title =
        location.pathname === "/dashboard"
            ? `Hi, ${userName}`
            : pageTitles[location.pathname] || "DPIRS PassPort";

    const subtitle =
        location.pathname === "/dashboard"
            ? ""
            : "DPIRS PassPort";

    const today = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
    });

    return (
        <header className="topbar">

            <div className="topbar-heading">
                <span className="topbar-accent" aria-hidden="true" />

                <div className="topbar-heading-text">
                    <h1 className="topbar-title">{title}</h1>
                    <p className="topbar-subtitle">{subtitle}</p>
                </div>
            </div>

            <div className="topbar-right">

                <span className="topbar-date">
                    <IconCalendar />
                    {today}
                </span>

                <button
                    className="topbar-bell"
                    type="button"
                    aria-label="Notifications"
                >
                    <IconBell />
                    <span className="topbar-bell-dot" aria-hidden="true" />
                </button>

                <Link
                    to="/profile"
                    className="topbar-profile"
                    aria-label="Open profile"
                >
                    <span className="topbar-avatar">{initials}</span>

                    <span className="topbar-profile-info">
                        <span className="topbar-profile-name">{userName}</span>
                        <span className="topbar-profile-role">{role}</span>
                    </span>

                    <span className="topbar-chevron">
                        <IconChevron />
                    </span>
                </Link>

            </div>

        </header>
    );
}

export default Topbar;
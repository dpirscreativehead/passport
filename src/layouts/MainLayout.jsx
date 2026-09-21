import { Outlet } from "react-router-dom";

import Sidebar from "./Sidebar/sidebar";
import Topbar from "./Topbar/topbar";

import "./MainLayout.css";

function MainLayout() {
    return (
        <div className="app-layout">

            <Sidebar />

            <main className="main-content">

                <Topbar />

                <div className="page-content">
                    <Outlet />
                </div>

            </main>

        </div>
    );
}

export default MainLayout;
import React, { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { hasPermission } from "../services/permissions";

function PermissionRoute({ permission }) {
    const [allowed, setAllowed] = useState(null);

    useEffect(() => {
        const checkPermission = async () => {
            const result = await hasPermission(permission);
            setAllowed(result);
        };

        checkPermission();
    }, [permission]);

    // While Firebase is being checked
    if (allowed === null) {
        return null;
    }

    // User doesn't have permission
    if (!allowed) {
        return <Navigate to="/dashboard" replace />;
    }

    // User has permission
    return <Outlet />;
}

export default PermissionRoute;
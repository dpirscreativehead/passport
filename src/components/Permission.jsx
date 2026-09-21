import React, { useEffect, useState } from "react";
import { hasPermission } from "../services/permissions";;

function Permission({ permission, children }) {
    const [allowed, setAllowed] = useState(false);

    useEffect(() => {
        const checkPermission = async () => {
            const result = await hasPermission(permission);
            setAllowed(result);
        };

        checkPermission();
    }, [permission]);

    if (!allowed) {
        return null;
    }

    return children;
}

export default Permission;
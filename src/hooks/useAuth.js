import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { onValue, ref } from "firebase/database";

import { auth, database } from "../firebase/config";

function useAuth() {
    const [user, setUser] = useState(null);
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let unsubscribeProfile = null;

        const unsubscribeAuth = onAuthStateChanged(
            auth,
            (currentUser) => {
                setUser(currentUser);

                if (unsubscribeProfile) {
                    unsubscribeProfile();
                    unsubscribeProfile = null;
                }

                if (!currentUser) {
                    setProfile(null);
                    setLoading(false);
                    return;
                }

                const profileRef = ref(
                    database,
                    `users/${currentUser.uid}/profile`
                );

                unsubscribeProfile = onValue(
                    profileRef,
                    (snapshot) => {
                        setProfile(snapshot.val() || {});
                        setLoading(false);
                    },
                    () => {
                        setProfile(null);
                        setLoading(false);
                    }
                );
            }
        );

        return () => {
            unsubscribeAuth();

            if (unsubscribeProfile) {
                unsubscribeProfile();
            }
        };
    }, []);

    return {
        user,
        profile,
        loading,
        isAuthenticated: !!user
    };
}

export default useAuth;
import { ref, get } from "firebase/database";
import { database } from "../firebase/config";

const permissions = {
    Admin: {
        Prefrences: false,
        Users: true,
        StudentManage: true,
        PassIssue: true,
        PassList: true,
        RequestManage: false,
        StaffManage: true,
        StaffPass: true,
        StaffPassList: true,
        ManageUsers: true,
    },

    Receptionist: {
        Prefrences: false,
        Users: false,
        StudentManage: false,
        PassIssue: true,
        PassList: true,
        RequestManage: false,
        StaffManage: false,
        StaffPass: true,
        StaffPassList: true,
        ManageUsers: false,
    },

    Principal: {
        RequestManage: true,
        PassList: true,
        StaffRequests: true,
        StaffPassList: true,
    }

    
};

export async function hasPermission(permission) {
    try {
        // Get the logged-in user's Firebase user ID
        const userid = localStorage.getItem("userid");

        if (!userid) {
            return false;
        }

        // Read users from Firebase
        const usersRef = ref(database, "users");
        const snapshot = await get(usersRef);

        if (!snapshot.exists()) {
            return false;
        }

        const users = snapshot.val();

        // Find the user using userid
        let currentUser = null;

        Object.entries(users).forEach(([firebaseId, user]) => {
            const userIdFromDatabase = user.userid || firebaseId;

            if (String(userIdFromDatabase) === String(userid)) {
                currentUser = user;
            }
        });

        if (!currentUser) {
            return false;
        }

        // Get role directly from Firebase
        const role = currentUser.role;

        if (!role) {
            return false;
        }

        // Check permission for the Firebase role
        return permissions[role]?.[permission] === true;

    } catch (error) {
        console.error("Permission check failed:", error);
        return false;
    }
}
export default permissions;


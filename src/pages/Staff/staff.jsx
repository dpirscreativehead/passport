import "./staff.css";
import StaffManage from "./components/StaffManage";
import StaffPass from "./components/StaffPass";
import Permission from "../../components/Permission";
import StaffRequests from "./components/StaffRequests";
import StaffPassList from "./components/StaffPassList";

function Staff() {    

    return (
        <div className="staff-page">
            <Permission permission="StaffManage">
                <StaffManage />
            </Permission>
            <Permission permission="StaffPass">
                <StaffPass />
            </Permission>
            <Permission permission="StaffRequests">
                <StaffRequests />
            </Permission>

            <Permission permission="StaffPassList">
                <StaffPassList />
            </Permission>

            
        </div>
    );
}

export default Staff;
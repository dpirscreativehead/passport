import "./student.css";
import { hasPermission } from "../../services/permissions";
import StudentManage from "./components/StudentManage";
import Permission from "../../components/Permission";
import PassIssue from "./components/PassIssue";
import RequestManage from "./components/RequestManage";
import PassList from "./components/PassList";

function Student() {
    return (
        <div className="student-page">
           <Permission permission="StudentManage">
              <StudentManage />
           </Permission>
           <Permission permission="PassIssue">
              <PassIssue />
           </Permission>
           <Permission permission="RequestManage">
              <RequestManage />
           </Permission> 
           <Permission permission="PassList">
               <PassList /> 
           </Permission>
                  
        </div>
      );
}


export default Student;

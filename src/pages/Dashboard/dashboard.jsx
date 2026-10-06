import "./dashboard.css";
import Permission from "../../components/Permission";
import MainDashboard from "./components/maindashboard";
import PrincipalDashboard from "./components/principaldashboard";


function Dashboard() {
    return (
      <div className="dashboard-container">
      <Permission permission="MainDashboard">  
      <MainDashboard />
      </Permission>
      <Permission permission="PrincipalDashboard">
      <PrincipalDashboard />
      </Permission>
      </div>
      


        
      );
      
}


export default Dashboard;

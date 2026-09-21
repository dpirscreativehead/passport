# 📁 Gate Pass - Project Structure

*Generated on: 9/21/2026, 11:22:15 PM*

## 📋 Quick Overview

| Metric | Value |
|--------|-------|
| 📄 Total Files | 64 |
| 📁 Total Folders | 27 |
| 🌳 Max Depth | 4 levels |
| 🛠️ Tech Stack | React, CSS, Node.js |

## ⭐ Important Files

- 🟡 🔒 **package-lock.json** - Dependency lock
- 🔴 📦 **package.json** - Package configuration
- 🔴 📖 **README.md** - Project documentation

## 📊 File Statistics

### By File Type

- ⚛️ **.jsx** (React JSX files): 26 files (40.6%)
- 🎨 **.css** (Stylesheets): 20 files (31.3%)
- 📜 **.js** (JavaScript files): 8 files (12.5%)
- 📖 **.md** (Markdown files): 4 files (6.3%)
- ⚙️ **.json** (JSON files): 2 files (3.1%)
- 📄 **.example** (Other files): 1 files (1.6%)
- 🌐 **.html** (HTML files): 1 files (1.6%)
- 📄 **.txt** (Text files): 1 files (1.6%)
- 🖼️ **.png** (PNG images): 1 files (1.6%)

### By Category

- **React**: 26 files (40.6%)
- **Styles**: 20 files (31.3%)
- **JavaScript**: 8 files (12.5%)
- **Docs**: 5 files (7.8%)
- **Config**: 2 files (3.1%)
- **Other**: 1 files (1.6%)
- **Web**: 1 files (1.6%)
- **Assets**: 1 files (1.6%)

### 📁 Largest Directories

- **root**: 64 files
- **src**: 54 files
- **src\pages**: 33 files
- **src\pages\Student**: 10 files
- **src\pages\Staff**: 10 files

## 🌳 Directory Structure

```
Gate Pass/
├── 📄 .env.example
├── 📖 docs/
│   └── 📖 architecture.md
├── 🌐 index.html
├── 🟡 🔒 **package-lock.json**
├── 🔴 📦 **package.json**
├── 📖 project_structure.md
├── 🌐 public/
│   └── 📄 favicon.ico.txt
├── 🔴 📖 **README.md**
├── 📖 requirements.md
├── 📁 src/
│   ├── ⚛️ App.jsx
│   ├── 📦 assets/
│   │   └── 🖼️ images/
│   │   │   └── 🖼️ passport-icon.png
│   ├── 🧩 components/
│   │   ├── ⚛️ Permission.jsx
│   │   ├── ⚛️ PermissionRoute.jsx
│   │   ├── ⚛️ ProtectedRoute.jsx
│   │   └── ⚛️ PublicRoute.jsx
│   ├── 📂 constants/
│   │   └── 📜 site.js
│   ├── 📂 firebase/
│   │   └── 📜 config.js
│   ├── 🎣 hooks/
│   │   └── 📜 useAuth.js
│   ├── 🎨 index.css
│   ├── 📂 layouts/
│   │   ├── 🎨 MainLayout.css
│   │   ├── ⚛️ MainLayout.jsx
│   │   ├── 📂 Sidebar/
│   │   │   ├── 🎨 sidebar.css
│   │   │   └── ⚛️ sidebar.jsx
│   │   └── 📂 Topbar/
│   │   │   ├── 🎨 topbar.css
│   │   │   └── ⚛️ topbar.jsx
│   ├── ⚛️ main.jsx
│   ├── 📄 pages/
│   │   ├── 📂 Dashboard/
│   │   │   ├── 🎨 dashboard.css
│   │   │   └── ⚛️ dashboard.jsx
│   │   ├── 📂 Login/
│   │   │   ├── 🎨 login.css
│   │   │   └── ⚛️ login.jsx
│   │   ├── 📂 Preferences/
│   │   │   ├── 🎨 preferences.css
│   │   │   └── ⚛️ preferences.jsx
│   │   ├── 📂 Profile/
│   │   │   ├── 🎨 profile.css
│   │   │   └── ⚛️ profile.jsx
│   │   ├── 📂 Reports/
│   │   │   ├── 🧩 components/
│   │   │   ├── 🎨 reports.css
│   │   │   └── ⚛️ reports.jsx
│   │   ├── 📂 Staff/
│   │   │   ├── 🧩 components/
│   │   │   │   ├── 🎨 StaffManage.css
│   │   │   │   ├── ⚛️ StaffManage.jsx
│   │   │   │   ├── 🎨 StaffPass.css
│   │   │   │   ├── ⚛️ StaffPass.jsx
│   │   │   │   ├── 🎨 StaffPassList.css
│   │   │   │   ├── ⚛️ StaffPassList.jsx
│   │   │   │   ├── 🎨 StaffRequests.css
│   │   │   │   └── ⚛️ StaffRequests.jsx
│   │   │   ├── 🎨 staff.css
│   │   │   └── ⚛️ staff.jsx
│   │   ├── 📂 Student/
│   │   │   ├── 🧩 components/
│   │   │   │   ├── 🎨 PassIssue.css
│   │   │   │   ├── ⚛️ PassIssue.jsx
│   │   │   │   ├── 🎨 PassList.css
│   │   │   │   ├── ⚛️ PassList.jsx
│   │   │   │   ├── 🎨 RequestManage.css
│   │   │   │   ├── ⚛️ RequestManage.jsx
│   │   │   │   ├── 🎨 StudentManage.css
│   │   │   │   └── ⚛️ StudentManage.jsx
│   │   │   ├── 🎨 student.css
│   │   │   └── ⚛️ student.jsx
│   │   └── 📂 Users/
│   │   │   ├── 🧩 components/
│   │   │   │   ├── 🎨 ManageUser.css
│   │   │   │   └── ⚛️ ManageUser.jsx
│   │   │   └── ⚛️ users.jsx
│   ├── 📂 services/
│   │   ├── 📜 authService.js
│   │   ├── 📜 contactService.js
│   │   └── 📜 permissions.js
│   └── 🔧 utils/
│   │   └── 📜 helpers.js
└── 📜 vite.config.js
```

## 📖 Legend

### File Types
- 📄 Other: Other files
- 🌐 Web: HTML files
- ⚙️ Config: JSON files
- 📖 Docs: Markdown files
- 📜 JavaScript: JavaScript files
- 📄 Docs: Text files
- ⚛️ React: React JSX files
- 🎨 Styles: Stylesheets
- 🖼️ Assets: PNG images

### Importance Levels
- 🔴 Critical: Essential project files
- 🟡 High: Important configuration files
- 🔵 Medium: Helpful but not essential files

// tsx asks os.userInfo() for a temporary-directory suffix on Windows. Some
// constrained runners cannot provide it; a numeric id selects the same safe path.
if (!process.geteuid) process.geteuid = () => 0;

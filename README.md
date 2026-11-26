# HAL Opcenter OEE – UI Prototype

This is an ASP.NET Core MVC (.NET 8) local OEE dashboard that reads machine records from SQL Server LocalDB.

## Run
1. Install the .NET 8 SDK.
2. Open a terminal in this folder.
3. Run: `dotnet restore`
4. Run: `dotnet run`
5. Open the localhost URL printed in the terminal.

## Integration
The MVC dashboard reads `dbo.MachineData` from `HALProcessRecord` using the `MachineData` connection string in `appsettings.json`. The database machine key is `MRB_3000` for the displayed `MRB 3000`. The UI refreshes every 15 seconds. Completed parts are represented as rising AutoStartLed-to-AutoStopLed pairs.

The user selects a calendar date and one of All shifts, Shift 1, Shift 2, or Shift 3, and the API queries only that date/shift window.

## Metrics
- **Availability** is calculated as machine-on time divided by the selected reporting window and is shown only when sample coverage is sufficient.
- **Quality** is fixed at 100%.
- **Performance** percentage is calculated as completed parts divided by a target of 30 parts per 8-hour shift (scaled proportionally for All shifts).
- **OEE** is Availability × Quality × Performance using percentage values divided by 10,000.

The UI also indicates when the latest database sample is stale and requires LocalDB access under the app's Windows identity.

## Important
This is a local prototype; the dashboard requires the specified LocalDB database and current Windows identity.

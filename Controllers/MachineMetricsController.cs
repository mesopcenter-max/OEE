using HAL_Opcenter_OEE_UI.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using System.Globalization;

namespace HAL_Opcenter_OEE_UI.Controllers;

[ApiController]
[Route("api/machine-metrics")]
public sealed class MachineMetricsController : ControllerBase
{
    private static readonly HashSet<string> ValidShifts = ["all", "1", "2", "3"];
    private readonly MachineMetricsService _metricsService;
    private readonly ILogger<MachineMetricsController> _logger;

    public MachineMetricsController(MachineMetricsService metricsService, ILogger<MachineMetricsController> logger)
    {
        _metricsService = metricsService;
        _logger = logger;
    }

    [HttpGet]
    public async Task<IActionResult> Get(string? date, string shift = "all", CancellationToken cancellationToken = default)
    {
        shift = shift.ToLowerInvariant();
        if (!ValidShifts.Contains(shift))
        {
            return BadRequest(new { error = "Use shift=all|1|2|3." });
        }

        if (!DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var selectedDate))
        {
            return BadRequest(new { error = "Invalid date format. Use date=yyyy-MM-dd." });
        }

        try
        {
            return Ok(await _metricsService.GetMetricsAsync(selectedDate, shift, cancellationToken));
        }
        catch (SqlException exception)
        {
            _logger.LogError(exception, "Unable to read machine metrics from HALProcessRecord.");
            return Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Local machine database is unavailable.",
                detail: "Check that (localdb)\\MSSQLLocalDB is running and HALProcessRecord is accessible.");
        }
    }
}

using System.Data;
using HAL_Opcenter_OEE_UI.Models;
using Microsoft.Data.SqlClient;

namespace HAL_Opcenter_OEE_UI.Services;

public sealed class MachineMetricsService
{
    private const string DatabaseMachineName = "MRB_3000";
    private const int MaximumSampleGapSeconds = 5;
    private static readonly TimeSpan DataFreshnessLimit = TimeSpan.FromSeconds(30);
    private const int TargetPartsPerEightHourShift = 30;
    private const double EightHourShiftSeconds = 8 * 60 * 60;
    private readonly string _connectionString;

    public MachineMetricsService(IConfiguration configuration)
    {
        _connectionString = configuration.GetConnectionString("MachineData")
            ?? throw new InvalidOperationException("Connection string 'MachineData' is not configured.");
    }

    public async Task<MachineMetrics> GetMetricsAsync(DateOnly selectedDate, string shift, CancellationToken cancellationToken)
    {
        var now = DateTime.Now;
        var window = CreateWindow(selectedDate, shift);
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);

        var latestSample = await GetLatestSampleAsync(connection, cancellationToken);
        double? dataAge = latestSample is null ? null : (now - latestSample.CapturedAt).TotalSeconds;
        var isDataFresh = dataAge is >= 0 and <= 30;

        var totals = await ReadWindowAsync(connection, window, latestSample, isDataFresh, now, cancellationToken);
        var windowSeconds = (window.End - window.Start).TotalSeconds;
        var coveragePercent = window.End > window.Start ? Math.Min(100, totals.ObservedSeconds / windowSeconds * 100) : 0;
        double? availabilityPercent = totals.ObservedSeconds > 0
            ? Math.Clamp(totals.RunningSeconds / totals.ObservedSeconds * 100, 0, 100)
            : null;
        double? performancePercent = totals.SampleCount > 0 && totals.ObservedSeconds > 0
            ? totals.Parts * 100d / (TargetPartsPerEightHourShift * totals.ObservedSeconds / EightHourShiftSeconds)
            : null;
        double qualityPercent = 100d;
        double? oeePercent = availabilityPercent is null || performancePercent is null
            ? null
            : availabilityPercent.Value * qualityPercent * performancePercent.Value / 10000d;

        var machineState = totals.LastWindowSample is null
            ? "No records for selected date/shift"
            : totals.LastWindowSample.AutoStartLed && !totals.LastWindowSample.AutoStopLed
                ? "Running"
                : totals.LastWindowSample.AutoStopLed && !totals.LastWindowSample.AutoStartLed
                    ? "Stopped"
                    : "Unknown";

        return new MachineMetrics(
            "MRB 3000",
            window.Start,
            window.End,
            totals.SampleCount,
            totals.LastWindowSample?.CapturedAt,
            machineState,
            latestSample?.CapturedAt,
            isDataFresh,
            totals.Starts,
            totals.Stops,
            totals.Parts,
            availabilityPercent is null ? null : Math.Round(availabilityPercent.Value, 1),
            performancePercent is null ? null : Math.Round(performancePercent.Value, 1),
            qualityPercent,
            oeePercent,
            (long)Math.Round(totals.RunningSeconds),
            (long)Math.Round(windowSeconds),
            Math.Round(coveragePercent, 1),
            BuildTimeSeries(totals.Buckets, window),
            totals.StatusTimeline);
    }

    private static async Task<Sample?> GetLatestSampleAsync(SqlConnection connection, CancellationToken cancellationToken)
    {
        const string query = """
            SELECT TOP (1) [CapturedAt], [AutoStartLed], [AutoStopLed]
            FROM [dbo].[MachineData]
            WHERE [Machine] = @machine
            ORDER BY [CapturedAt] DESC;
            """;

        await using var command = new SqlCommand(query, connection);
        command.Parameters.Add("@machine", SqlDbType.NVarChar, 100).Value = DatabaseMachineName;
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new Sample(reader.GetDateTime(0), reader.GetBoolean(1), reader.GetBoolean(2))
            : null;
    }

    private static async Task<WindowTotals> ReadWindowAsync(
        SqlConnection connection,
        TimeWindow window,
        Sample? latestSample,
        bool isDataFresh,
        DateTime now,
        CancellationToken cancellationToken)
    {
        const string query = """
            WITH PreviousSample AS
            (
                SELECT TOP (1) [CapturedAt], [AutoStartLed], [AutoStopLed]
                FROM [dbo].[MachineData]
                WHERE [Machine] = @machine AND [CapturedAt] < @from
                ORDER BY [CapturedAt] DESC
            ), WindowSamples AS
            (
                SELECT [CapturedAt], [AutoStartLed], [AutoStopLed]
                FROM [dbo].[MachineData]
                WHERE [Machine] = @machine AND [CapturedAt] >= @from AND [CapturedAt] < @to
                UNION ALL
                SELECT [CapturedAt], [AutoStartLed], [AutoStopLed]
                FROM PreviousSample
            )
            SELECT [CapturedAt], [AutoStartLed], [AutoStopLed]
            FROM WindowSamples
            ORDER BY [CapturedAt];
            """;

        await using var command = new SqlCommand(query, connection);
        command.Parameters.Add("@machine", SqlDbType.NVarChar, 100).Value = DatabaseMachineName;
        command.Parameters.Add("@from", SqlDbType.DateTime2).Value = window.Start;
        command.Parameters.Add("@to", SqlDbType.DateTime2).Value = window.End;

        long starts = 0;
        long stops = 0;
        long parts = 0;
        double runningSeconds = 0;
        double observedSeconds = 0;
        long sampleCount = 0;
        Sample? lastWindowSample = null;
        var pendingStart = false;
        Sample? previous = null;

        var bucketCount = (int)Math.Ceiling((window.End - window.Start).TotalSeconds / TimeSeriesBucketSeconds);
        var buckets = Enumerable.Range(0, bucketCount).Select(_ => new MetricsBucket()).ToArray();
        var statusTimeline = new List<MachineStatusPeriod>();
        var timelineCursor = window.Start;

        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                var current = new Sample(reader.GetDateTime(0), reader.GetBoolean(1), reader.GetBoolean(2));
                if (current.CapturedAt >= window.Start && current.CapturedAt < window.End)
                {
                    sampleCount++;
                    lastWindowSample = current;
                }

                if (previous is null)
                {
                    pendingStart = current.CapturedAt < window.Start
                        && (window.Start - current.CapturedAt).TotalSeconds <= MaximumSampleGapSeconds
                        && current.AutoStartLed;
                    previous = current;
                    continue;
                }

                var gapSeconds = (current.CapturedAt - previous.CapturedAt).TotalSeconds;
                if (gapSeconds > 0 && gapSeconds <= MaximumSampleGapSeconds)
                {
                    var intervalStart = Max(previous.CapturedAt, window.Start);
                    var intervalEnd = Min(current.CapturedAt, window.End);
                    var intervalSeconds = Math.Max(0, (intervalEnd - intervalStart).TotalSeconds);
                    observedSeconds += intervalSeconds;
                    if (previous.AutoStartLed)
                    {
                        runningSeconds += intervalSeconds;
                    }

                    AddIntervalToBuckets(buckets, window, intervalStart, intervalEnd, previous.AutoStartLed);
                    AddStatusPeriod(statusTimeline, ref timelineCursor, intervalStart, intervalEnd, previous.AutoStartLed ? "Running" : "Stopped", window);

                    if (current.CapturedAt >= window.Start && current.CapturedAt < window.End)
                    {
                        var bucketIndex = GetBucketIndex(current.CapturedAt, window, buckets.Length);
                        if (!previous.AutoStartLed && current.AutoStartLed)
                        {
                            starts++;
                            buckets[bucketIndex].Starts++;
                            pendingStart = true;
                        }

                        if (!previous.AutoStopLed && current.AutoStopLed)
                        {
                            stops++;
                            buckets[bucketIndex].Stops++;
                            if (pendingStart)
                            {
                                parts++;
                                buckets[bucketIndex].Parts++;
                                pendingStart = false;
                            }
                        }
                    }
                }

                previous = current;
            }
        }

        if (previous is not null
            && isDataFresh
            && latestSample?.CapturedAt == previous.CapturedAt
            && previous.AutoStartLed)
        {
            var intervalStart = Max(previous.CapturedAt, window.Start);
            var intervalEnd = Min(Min(now, window.End), previous.CapturedAt.AddSeconds(MaximumSampleGapSeconds));
            var intervalSeconds = Math.Max(0, (intervalEnd - intervalStart).TotalSeconds);
            runningSeconds += intervalSeconds;
            observedSeconds += intervalSeconds;

            AddIntervalToBuckets(buckets, window, intervalStart, intervalEnd, previous.AutoStartLed);
            AddStatusPeriod(statusTimeline, ref timelineCursor, intervalStart, intervalEnd, previous.AutoStartLed ? "Running" : "Stopped", window);
        }

        if (timelineCursor < window.End)
        {
            AddOrMergeStatusPeriod(statusTimeline, timelineCursor, window.End, "Unknown");
        }

        return new WindowTotals(starts, stops, parts, runningSeconds, observedSeconds, sampleCount, lastWindowSample, buckets, statusTimeline);
    }

    private static TimeWindow CreateWindow(DateOnly date, string shift)
    {
        var start = date.ToDateTime(TimeOnly.MinValue);

        return shift switch
        {
            "all" => new TimeWindow(start, start.AddDays(1)),
            "1" => new TimeWindow(start.AddHours(7), start.AddHours(15)),
            "2" => new TimeWindow(start.AddHours(15), start.AddHours(23)),
            "3" => new TimeWindow(start.AddHours(23), start.AddDays(1).AddHours(7)),
            _ => throw new ArgumentOutOfRangeException(nameof(shift))
        };
    }

    private const double TimeSeriesBucketSeconds = 1800;

    private static IReadOnlyList<MetricTimePoint> BuildTimeSeries(MetricsBucket[] buckets, TimeWindow window)
    {
        var points = new List<MetricTimePoint>(buckets.Length);
        for (var index = 0; index < buckets.Length; index++)
        {
            var bucketStart = window.Start.AddSeconds(index * TimeSeriesBucketSeconds);
            var bucketSeconds = Math.Min(TimeSeriesBucketSeconds, (window.End - bucketStart).TotalSeconds);
            var bucket = buckets[index];
            var coverage = bucketSeconds > 0 ? bucket.ObservedSeconds / bucketSeconds * 100 : 0;
            double? availability = coverage >= 50 && bucket.ObservedSeconds > 0
                ? Math.Clamp(bucket.RunningSeconds / bucket.ObservedSeconds * 100, 0, 100)
                : null;
            double? performance = coverage >= 50 && bucket.ObservedSeconds > 0
                ? bucket.Parts * 100d / (TargetPartsPerEightHourShift * bucket.ObservedSeconds / EightHourShiftSeconds)
                : null;
            double? quality = coverage >= 50 ? 100d : null;
            double? oee = availability is null || performance is null || quality is null
                ? null
                : availability.Value * quality.Value * performance.Value / 10000d;
            points.Add(new MetricTimePoint(bucketStart, oee, availability, performance, quality));
        }

        return points;
    }

    private static void AddIntervalToBuckets(MetricsBucket[] buckets, TimeWindow window, DateTime start, DateTime end, bool isRunning)
    {
        var cursor = Max(start, window.Start);
        var clippedEnd = Min(end, window.End);
        while (cursor < clippedEnd)
        {
            var bucketIndex = GetBucketIndex(cursor, window, buckets.Length);
            var bucketEnd = Min(clippedEnd, window.Start.AddSeconds((bucketIndex + 1) * TimeSeriesBucketSeconds));
            var seconds = (bucketEnd - cursor).TotalSeconds;
            buckets[bucketIndex].ObservedSeconds += seconds;
            if (isRunning)
            {
                buckets[bucketIndex].RunningSeconds += seconds;
            }
            cursor = bucketEnd;
        }
    }

    private static int GetBucketIndex(DateTime timestamp, TimeWindow window, int bucketCount)
    {
        var index = (int)((timestamp - window.Start).TotalSeconds / TimeSeriesBucketSeconds);
        return Math.Clamp(index, 0, bucketCount - 1);
    }

    private static void AddStatusPeriod(List<MachineStatusPeriod> periods, ref DateTime cursor, DateTime start, DateTime end, string state, TimeWindow window)
    {
        start = Max(start, window.Start);
        end = Min(end, window.End);
        if (end <= start)
        {
            return;
        }

        if (start > cursor)
        {
            AddOrMergeStatusPeriod(periods, cursor, start, "Unknown");
        }

        start = Max(start, cursor);
        if (end > start)
        {
            AddOrMergeStatusPeriod(periods, start, end, state);
            cursor = end;
        }
    }

    private static void AddOrMergeStatusPeriod(List<MachineStatusPeriod> periods, DateTime start, DateTime end, string state)
    {
        if (periods.Count > 0 && periods[^1].State == state && periods[^1].EndAt == start)
        {
            var previous = periods[^1];
            periods[^1] = previous with { EndAt = end, DurationSeconds = (end - previous.StartAt).TotalSeconds };
        }
        else
        {
            periods.Add(new MachineStatusPeriod(start, end, state, (end - start).TotalSeconds));
        }
    }

    private static DateTime Min(DateTime left, DateTime right) => left <= right ? left : right;
    private static DateTime Max(DateTime left, DateTime right) => left >= right ? left : right;

    private sealed class MetricsBucket
    {
        public double ObservedSeconds { get; set; }
        public double RunningSeconds { get; set; }
        public long Starts { get; set; }
        public long Stops { get; set; }
        public long Parts { get; set; }
    }

    private sealed record Sample(DateTime CapturedAt, bool AutoStartLed, bool AutoStopLed);
    private sealed record TimeWindow(DateTime Start, DateTime End);
    private sealed record WindowTotals(long Starts, long Stops, long Parts, double RunningSeconds, double ObservedSeconds, long SampleCount, Sample? LastWindowSample, MetricsBucket[] Buckets, IReadOnlyList<MachineStatusPeriod> StatusTimeline);
}

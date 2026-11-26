namespace HAL_Opcenter_OEE_UI.Models;

public sealed record MachineMetrics(
    string Machine,
    DateTime WindowStartAt,
    DateTime WindowEndAt,
    long SampleCount,
    DateTime? LastWindowSampleAt,
    string MachineState,
    DateTime? LastSampleAt,
    bool IsDataFresh,
    long StartEvents,
    long StopEvents,
    long PartsExecuted,
    double? AvailabilityPercent,
    double? PerformancePercent,
    double QualityPercent,
    double? OeePercent,
    long RunningSeconds,
    long WindowSeconds,
    double DataCoveragePercent);

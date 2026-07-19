class WorkerError(Exception):
    code = "ANALYSIS_FAILED"
    recoverable = True


class InvalidRequestError(WorkerError):
    code = "INVALID_REQUEST"


class VideoError(WorkerError):
    code = "VIDEO_UNREADABLE"


class WeightError(WorkerError):
    code = "WEIGHT_MISSING"


class DeviceError(WorkerError):
    code = "DEVICE_UNAVAILABLE"


class CalibrationError(WorkerError):
    code = "INVALID_CALIBRATION"


class TimestampError(WorkerError):
    code = "INVALID_TIMESTAMPS"


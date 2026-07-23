# DRAFT — generated from request REQ-W3; an engineer must review,
# complete the TODOs, and own this block. NOT applied by any pipeline.

# TODO: Tables, with their own memory/magnetic-store retention properties, are an engineer follow-up after the database exists

resource "aws_timestreamwrite_database" "iot_telemetry" {
  database_name = "iot-telemetry"
  tags = {
    Name = "iot-telemetry"
    Description = "Time-series store for IoT telemetry"
    PIC = "Ops team"
  }
}

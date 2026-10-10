-- One row per app, UTC day, install, and set of dimension values. `dims` and
-- `counts` are JSON objects; query them with json_extract().

CREATE TABLE reports (
	app TEXT NOT NULL CHECK (length(app) BETWEEN 1 AND 48),
	day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	install_id TEXT NOT NULL CHECK (length(install_id) = 36),
	version TEXT NOT NULL CHECK (length(version) <= 14),
	dims TEXT NOT NULL CHECK (json_valid(dims) AND length(dims) <= 2048),
	counts TEXT NOT NULL CHECK (json_valid(counts) AND length(counts) <= 4096),
	PRIMARY KEY (app, day, install_id, dims)
);

-- Rows written per UTC day, for the Worker's daily cap.
CREATE TABLE daily_writes (
	day TEXT PRIMARY KEY,
	rows INTEGER NOT NULL
);

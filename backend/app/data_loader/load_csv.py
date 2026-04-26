"""
Load real demographic data from CSV into the database.
CSV format:
oktmo;not_zato;region;mun_type;municipality;year;population;average_population;
deaths;births;migration;mortality_rate;birth_rate;migration_rate;area
"""

import csv
from pathlib import Path

from sqlalchemy import delete, func, select

from app.config import settings
from app.database import async_session
from app.models.demographics import DemographicIndicator
from app.models.forecast import Forecast
from app.models.municipality import Municipality
from app.models.population import PopulationRecord
from app.models.region import Region
from app.models.report import Report

# Federal district mapping by region name
FEDERAL_DISTRICTS = {
    "Алтайский край": "Сибирский",
    "Амурская область": "Дальневосточный",
    "Архангельская область": "Северо-Западный",
    "Астраханская область": "Южный",
    "Белгородская область": "Центральный",
    "Брянская область": "Центральный",
    "Владимирская область": "Центральный",
    "Волгоградская область": "Южный",
    "Вологодская область": "Северо-Западный",
    "Воронежская область": "Центральный",
    "Еврейская автономная область": "Дальневосточный",
    "Забайкальский край": "Дальневосточный",
    "Ивановская область": "Центральный",
    "Иркутская область": "Сибирский",
    "Кабардино-Балкарская Республика": "Северо-Кавказский",
    "Калининградская область": "Северо-Западный",
    "Калужская область": "Центральный",
    "Камчатский край": "Дальневосточный",
    "Карачаево-Черкесская Республика": "Северо-Кавказский",
    "Кемеровская область": "Сибирский",
    "Кировская область": "Приволжский",
    "Костромская область": "Центральный",
    "Краснодарский край": "Южный",
    "Красноярский край": "Сибирский",
    "Курганская область": "Уральский",
    "Курская область": "Центральный",
    "Ленинградская область": "Северо-Западный",
    "Липецкая область": "Центральный",
    "Магаданская область": "Дальневосточный",
    "Москва": "Центральный",
    "Московская область": "Центральный",
    "Мурманская область": "Северо-Западный",
    "Ненецкий автономный округ": "Северо-Западный",
    "Нижегородская область": "Приволжский",
    "Новгородская область": "Северо-Западный",
    "Новосибирская область": "Сибирский",
    "Омская область": "Сибирский",
    "Оренбургская область": "Приволжский",
    "Орловская область": "Центральный",
    "Пензенская область": "Приволжский",
    "Пермский край": "Приволжский",
    "Приморский край": "Дальневосточный",
    "Псковская область": "Северо-Западный",
    "Республика Адыгея": "Южный",
    "Республика Алтай": "Сибирский",
    "Республика Башкортостан": "Приволжский",
    "Республика Бурятия": "Дальневосточный",
    "Республика Дагестан": "Северо-Кавказский",
    "Республика Ингушетия": "Северо-Кавказский",
    "Республика Калмыкия": "Южный",
    "Республика Карелия": "Северо-Западный",
    "Республика Коми": "Северо-Западный",
    "Республика Крым": "Южный",
    "Республика Марий Эл": "Приволжский",
    "Республика Мордовия": "Приволжский",
    "Республика Саха (Якутия)": "Дальневосточный",
    "Республика Северная Осетия — Алания": "Северо-Кавказский",
    "Республика Татарстан": "Приволжский",
    "Республика Тыва": "Сибирский",
    "Республика Хакасия": "Сибирский",
    "Ростовская область": "Южный",
    "Рязанская область": "Центральный",
    "Самарская область": "Приволжский",
    "Санкт-Петербург": "Северо-Западный",
    "Саратовская область": "Приволжский",
    "Сахалинская область": "Дальневосточный",
    "Свердловская область": "Уральский",
    "Севастополь": "Южный",
    "Смоленская область": "Центральный",
    "Ставропольский край": "Северо-Кавказский",
    "Тамбовская область": "Центральный",
    "Тверская область": "Центральный",
    "Томская область": "Сибирский",
    "Тульская область": "Центральный",
    "Тюменская область": "Уральский",
    "Удмуртская Республика": "Приволжский",
    "Ульяновская область": "Приволжский",
    "Хабаровский край": "Дальневосточный",
    "Ханты-Мансийский автономный округ - Югра": "Уральский",
    "Челябинская область": "Уральский",
    "Чеченская Республика": "Северо-Кавказский",
    "Чувашская Республика": "Приволжский",
    "Чукотский автономный округ": "Дальневосточный",
    "Ямало-Ненецкий автономный округ": "Уральский",
    "Ярославская область": "Центральный",
}

MUN_TYPE_MAP = {
    "Городской округ": "городской_округ",
    "Муниципальный район": "муниципальный_район",
    "Муниципальный округ": "муниципальный_округ",
    "Административный район": "административный_район",
    "Город федерального значения": "город_фед_значения",
}


def _safe_int(val: str | None) -> int | None:
    if not val or not val.strip():
        return None
    try:
        return int(float(val.strip()))
    except (ValueError, TypeError):
        return None


def _safe_float(val: str | None) -> float | None:
    if not val or not val.strip():
        return None
    try:
        return float(val.strip())
    except (ValueError, TypeError):
        return None


def _candidate_data_dirs() -> list[Path]:
    backend_dir = Path(__file__).resolve().parents[2]
    return [
        Path(settings.data_dir),
        backend_dir / "data",
        Path("/app/data"),
    ]


def _find_csv_file() -> Path | None:
    for data_dir in _candidate_data_dirs():
        csv_dir = data_dir / "csv"
        if not csv_dir.exists():
            continue

        preferred_file = csv_dir / "data.csv"
        if preferred_file.is_file():
            return preferred_file

        demography_files = sorted(
            p for p in csv_dir.iterdir()
            if p.is_file() and p.suffix == ".csv" and "demography" in p.name.lower()
        )
        if demography_files:
            return demography_files[0]

        any_csv_files = sorted(
            p for p in csv_dir.iterdir()
            if p.is_file() and p.suffix == ".csv"
        )
        if any_csv_files:
            return any_csv_files[0]
    return None


def _hectares_to_sq_km(val: str | None) -> float | None:
    hectares = _safe_float(val)
    if hectares is None:
        return None
    return round(hectares / 100, 4)


def _read_csv_data(
    csv_file: Path,
) -> tuple[dict[str, dict], dict[str, dict], list[dict]]:
    regions: dict[str, dict] = {}
    municipalities: dict[str, dict] = {}
    rows_data: list[dict] = []

    with csv_file.open("r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=";")
        required_columns = {
            "oktmo",
            "region",
            "mun_type",
            "municipality",
            "year",
            "population",
            "deaths",
            "births",
            "migration",
            "mortality_rate",
            "birth_rate",
            "migration_rate",
        }
        missing_columns = required_columns - set(reader.fieldnames or [])
        if missing_columns:
            missing = ", ".join(sorted(missing_columns))
            raise ValueError(f"CSV file is missing required columns: {missing}")

        for row in reader:
            region_name = row["region"].strip()
            oktmo = row["oktmo"].strip()
            region_code = oktmo[:2] if len(oktmo) >= 2 else ""
            area_sq_km = _hectares_to_sq_km(row.get("area"))

            if region_name not in regions:
                regions[region_name] = {
                    "code": region_code,
                    "federal_district": FEDERAL_DISTRICTS.get(region_name, ""),
                }

            if oktmo not in municipalities:
                mun_type = row["mun_type"].strip()
                municipalities[oktmo] = {
                    "name": row["municipality"].strip(),
                    "type": MUN_TYPE_MAP.get(mun_type, mun_type),
                    "region": region_name,
                    "area_sq_km": area_sq_km,
                }
            elif municipalities[oktmo].get("area_sq_km") is None and area_sq_km is not None:
                municipalities[oktmo]["area_sq_km"] = area_sq_km

            rows_data.append(row)

    return regions, municipalities, rows_data


async def _row_count(db, model) -> int:
    result = await db.execute(select(func.count(model.id)))
    return int(result.scalar_one())


async def _municipality_area_count(db) -> int:
    result = await db.execute(
        select(func.count(Municipality.id))
        .where(Municipality.area_sq_km.is_not(None))
    )
    return int(result.scalar_one())


async def _clear_loaded_data(db) -> None:
    await db.execute(delete(Forecast))
    await db.execute(delete(Report))
    await db.execute(delete(DemographicIndicator))
    await db.execute(delete(PopulationRecord))
    await db.execute(delete(Municipality))
    await db.execute(delete(Region))
    await db.flush()


async def load_csv_data(force_reload: bool = False):
    """Load tochno.st CSV into the database."""
    csv_file = _find_csv_file()

    if not csv_file:
        print("CSV file not found in data/csv/. Using demo data.")
        from app.data_loader.seed_data import seed_database
        await seed_database()
        return

    regions_data, municipalities_data, rows_data = _read_csv_data(csv_file)
    csv_population_rows = sum(
        1 for row in rows_data if _safe_int(row.get("population")) is not None
    )
    csv_area_municipalities = sum(
        1 for municipality in municipalities_data.values() if municipality.get("area_sq_km") is not None
    )

    async with async_session() as db:
        existing_regions = await _row_count(db, Region)
        existing_municipalities = await _row_count(db, Municipality)
        existing_population = await _row_count(db, PopulationRecord)
        existing_area_municipalities = await _municipality_area_count(db)

        if existing_regions and not force_reload:
            looks_loaded = (
                existing_municipalities >= len(municipalities_data)
                and existing_population >= csv_population_rows
                and existing_area_municipalities >= csv_area_municipalities
            )
            if looks_loaded:
                print("Database already populated with CSV data.")
                return

            print(
                "Existing database contains demo or partial data. "
                "Replacing it with the CSV dataset."
            )

        if existing_regions:
            await _clear_loaded_data(db)

        print(f"Loading data from {csv_file}...")

        # Create regions
        print(f"  Creating {len(regions_data)} regions...")
        region_db_map: dict[str, Region] = {}
        used_codes: set[str] = set()
        for index, (rname, rinfo) in enumerate(sorted(regions_data.items()), start=1):
            preferred_code = rinfo["code"] if rinfo["code"] else None
            if preferred_code and preferred_code not in used_codes:
                code = preferred_code
            else:
                code = None
                for attempt in range(1, 100):
                    candidate = str(attempt).zfill(2)
                    if candidate not in used_codes:
                        code = candidate
                        break
                if code is None:
                    raise RuntimeError("Не удалось назначить уникальный код региона (все 99 заняты)")
            used_codes.add(code)

            r = Region(
                code=code,
                name=rname,
                federal_district=rinfo["federal_district"],
            )
            db.add(r)
            region_db_map[rname] = r
        await db.flush()

        # Create municipalities
        print(f"  Creating {len(municipalities_data)} municipalities...")
        muni_db_map: dict[str, Municipality] = {}
        for oktmo, minfo in municipalities_data.items():
            region = region_db_map.get(minfo["region"])
            if not region:
                continue
            m = Municipality(
                oktmo_code=oktmo,
                name=minfo["name"],
                municipality_type=minfo["type"],
                region_id=region.id,
                area_sq_km=minfo.get("area_sq_km"),
            )
            db.add(m)
            muni_db_map[oktmo] = m
        await db.flush()

        # Load population and demographics
        print(f"  Loading {len(rows_data)} data rows...")
        batch_count = 0
        for row in rows_data:
            oktmo = row["oktmo"].strip()
            muni = muni_db_map.get(oktmo)
            if not muni:
                continue

            year = _safe_int(row["year"])
            if not year:
                continue

            population = _safe_int(row["population"])
            if population is not None:
                pr = PopulationRecord(
                    municipality_id=muni.id,
                    year=year,
                    population=population,
                )
                db.add(pr)

            births = _safe_int(row.get("births"))
            deaths = _safe_int(row.get("deaths"))
            migration = _safe_int(row.get("migration"))
            birth_rate_raw = _safe_float(row.get("birth_rate"))
            death_rate_raw = _safe_float(row.get("mortality_rate"))
            migration_rate_raw = _safe_float(row.get("migration_rate"))

            # Rates in CSV are decimal (0.012 = 12‰), convert to per-mille
            birth_rate = round(birth_rate_raw * 1000, 1) if birth_rate_raw is not None else None
            death_rate = round(death_rate_raw * 1000, 1) if death_rate_raw is not None else None
            migration_rate = round(migration_rate_raw * 1000, 1) if migration_rate_raw is not None else None

            natural_growth = (births - deaths) if births is not None and deaths is not None else None
            natural_growth_rate = (
                round(birth_rate - death_rate, 1)
                if birth_rate is not None and death_rate is not None
                else None
            )

            has_any = any(v is not None for v in [births, deaths, migration, birth_rate, death_rate])
            if has_any:
                di = DemographicIndicator(
                    municipality_id=muni.id,
                    year=year,
                    births=births,
                    deaths=deaths,
                    natural_growth=natural_growth,
                    net_migration=migration,
                    birth_rate=birth_rate,
                    death_rate=death_rate,
                    natural_growth_rate=natural_growth_rate,
                    net_migration_rate=migration_rate,
                )
                db.add(di)

            batch_count += 1
            if batch_count % 5000 == 0:
                await db.flush()
                print(f"    ... {batch_count} rows processed")

        await db.commit()
        print(
            f"Done! Loaded {len(region_db_map)} regions, "
            f"{len(muni_db_map)} municipalities, {batch_count} data rows."
        )

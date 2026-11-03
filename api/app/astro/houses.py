SIGNS = [
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
]


def sign_of(lon: float) -> str:
    return SIGNS[int((lon % 360.0) // 30)]


def degree_in_sign(lon: float) -> float:
    return lon % 30.0


def whole_sign_house(lon: float, asc_lon: float) -> int:
    """Whole Sign house (1-12): the Ascendant's sign is the 1st house."""
    return ((int(lon // 30) - int(asc_lon // 30)) % 12) + 1

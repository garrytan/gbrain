//! Generated from the PostgreSQL 18.6 `wparser_def.c` `actionTPS_*` tables (one item per C row,
//! same order) by `bun rust/scripts/gen-parser-actions.ts --write`. Do not edit by hand; see `parser.rs`
//! for the engine that runs them.
//! Derived from PostgreSQL 18.6; licence and notice: third-party/postgresql/NOTICE.md

use super::TokenType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum State {
    Base,
    InNumWord,
    InAsciiWord,
    InWord,
    InUnsignedInt,
    InSignedIntFirst,
    InSignedInt,
    InSpace,
    InUDecimalFirst,
    InUDecimal,
    InDecimalFirst,
    InDecimal,
    InVerVersion,
    InSVerVersion,
    InVersionFirst,
    InVersion,
    InMantissaFirst,
    InMantissaSign,
    InMantissa,
    InXMLEntityFirst,
    InXMLEntity,
    InXMLEntityNumFirst,
    InXMLEntityNum,
    InXMLEntityHexNumFirst,
    InXMLEntityHexNum,
    InXMLEntityEnd,
    InTagFirst,
    InXMLBegin,
    InTagCloseFirst,
    InTagName,
    InTagBeginEnd,
    InTag,
    InTagEscapeK,
    InTagEscapeKK,
    InTagBackSleshed,
    InTagEnd,
    InCommentFirst,
    InCommentLast,
    InComment,
    InCloseCommentFirst,
    InCloseCommentLast,
    InCommentEnd,
    InHostFirstDomain,
    InHostDomainSecond,
    InHostDomain,
    InPortFirst,
    InPort,
    InHostFirstAN,
    InHost,
    InEmail,
    InFileFirst,
    InFileTwiddle,
    InPathFirst,
    InPathFirstFirst,
    InPathSecond,
    InFile,
    InFileNext,
    InURLPathFirst,
    InURLPathStart,
    InURLPath,
    InFURL,
    InProtocolFirst,
    InProtocolSecond,
    InProtocolEnd,
    InHyphenAsciiWordFirst,
    InHyphenAsciiWord,
    InHyphenWordFirst,
    InHyphenWord,
    InHyphenNumWordFirst,
    InHyphenNumWord,
    InHyphenDigitLookahead,
    InParseHyphen,
    InParseHyphenHyphen,
    InHyphenWordPart,
    InHyphenAsciiWordPart,
    InHyphenNumWordPart,
    InHyphenUnsignedInt,
    Null,
}

/// The `p_is*` tests of the C parser. `Always` is the table terminator (a NULL `isclass`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Class {
    Eof,
    Eq,
    Asclet,
    Alpha,
    Digit,
    Alnum,
    NotAlnum,
    Special,
    Space,
    Xdigit,
    Ignore,
    StopHost,
    Host,
    UrlPath,
    UrlChar,
    Always,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Special {
    None,
    Tags,
    Furl,
    Hyphen,
    VerVersion,
}

pub(super) const A_NEXT: u16 = 0x0000;
pub(super) const A_BINGO: u16 = 0x0001;
pub(super) const A_POP: u16 = 0x0002;
pub(super) const A_PUSH: u16 = 0x0004;
pub(super) const A_RERUN: u16 = 0x0008;
pub(super) const A_CLEAR: u16 = 0x0010;
pub(super) const A_MERGE: u16 = 0x0020;
pub(super) const A_CLRALL: u16 = 0x0040;

#[derive(Debug, Clone, Copy)]
pub(super) struct Item {
    pub(super) class: Class,
    pub(super) c: u8,
    pub(super) flags: u16,
    pub(super) tostate: State,
    pub(super) ty: Option<TokenType>,
    pub(super) special: Special,
}

const fn item(
    class: Class,
    c: u8,
    flags: u16,
    tostate: State,
    ty: Option<TokenType>,
    special: Special,
) -> Item {
    Item {
        class,
        c,
        flags,
        tostate,
        ty,
        special,
    }
}

const ACT_BASE: &[Item] = &[
    item(Class::Eof, 0, A_NEXT, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'<',
        A_PUSH,
        State::InTagFirst,
        None,
        Special::None,
    ),
    item(
        Class::Ignore,
        0,
        A_NEXT,
        State::InSpace,
        None,
        Special::None,
    ),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InAsciiWord,
        None,
        Special::None,
    ),
    item(Class::Alpha, 0, A_NEXT, State::InWord, None, Special::None),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InUnsignedInt,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InSignedIntFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'+',
        A_PUSH,
        State::InSignedIntFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'&',
        A_PUSH,
        State::InXMLEntityFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'~',
        A_PUSH,
        State::InFileTwiddle,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'/',
        A_PUSH,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InPathFirstFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_NEXT,
        State::InSpace,
        None,
        Special::None,
    ),
];

const ACT_INNUMWORD: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Numword),
        Special::None,
    ),
    item(
        Class::Alnum,
        0,
        A_NEXT,
        State::InNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InNumWord,
        None,
        Special::None,
    ),
    item(Class::Eq, b'@', A_PUSH, State::InEmail, None, Special::None),
    item(
        Class::Eq,
        b'/',
        A_PUSH,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InFileNext,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHyphenNumWordFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Numword),
        Special::None,
    ),
];

const ACT_INASCIIWORD: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Asciiword),
        Special::None,
    ),
    item(Class::Asclet, 0, A_NEXT, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InHostFirstDomain,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InFileNext,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHyphenAsciiWordFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'_',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(Class::Eq, b'@', A_PUSH, State::InEmail, None, Special::None),
    item(
        Class::Eq,
        b':',
        A_PUSH,
        State::InProtocolFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'/',
        A_PUSH,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(Class::Digit, 0, A_PUSH, State::InHost, None, Special::None),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InNumWord,
        None,
        Special::None,
    ),
    item(Class::Alpha, 0, A_NEXT, State::InWord, None, Special::None),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InWord,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Asciiword),
        Special::None,
    ),
];

const ACT_INWORD: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Word),
        Special::None,
    ),
    item(Class::Alpha, 0, A_NEXT, State::Null, None, Special::None),
    item(Class::Special, 0, A_NEXT, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHyphenWordFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Word),
        Special::None,
    ),
];

const ACT_INUNSIGNEDINT: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Uint),
        Special::None,
    ),
    item(Class::Digit, 0, A_NEXT, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InHostFirstDomain,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InUDecimalFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'e',
        A_PUSH,
        State::InMantissaFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'E',
        A_PUSH,
        State::InMantissaFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'_',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(Class::Eq, b'@', A_PUSH, State::InEmail, None, Special::None),
    item(Class::Asclet, 0, A_PUSH, State::InHost, None, Special::None),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'/',
        A_PUSH,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Uint),
        Special::None,
    ),
];

const ACT_INSIGNEDINTFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_NEXT | A_CLEAR,
        State::InSignedInt,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INSIGNEDINT: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Int),
        Special::None,
    ),
    item(Class::Digit, 0, A_NEXT, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InDecimalFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'e',
        A_PUSH,
        State::InMantissaFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'E',
        A_PUSH,
        State::InMantissaFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Int),
        Special::None,
    ),
];

const ACT_INSPACE: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(
        Class::Eq,
        b'<',
        A_BINGO,
        State::Base,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(Class::Ignore, 0, A_NEXT, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'-',
        A_BINGO,
        State::Base,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(
        Class::Eq,
        b'+',
        A_BINGO,
        State::Base,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(
        Class::Eq,
        b'&',
        A_BINGO,
        State::Base,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(
        Class::Eq,
        b'/',
        A_BINGO,
        State::Base,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(
        Class::NotAlnum,
        0,
        A_NEXT,
        State::InSpace,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Blank),
        Special::None,
    ),
];

const ACT_INUDECIMALFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_CLEAR,
        State::InUDecimal,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INUDECIMAL: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Float),
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InUDecimal,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InVersionFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'e',
        A_PUSH,
        State::InMantissaFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'E',
        A_PUSH,
        State::InMantissaFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Float),
        Special::None,
    ),
];

const ACT_INDECIMALFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_CLEAR,
        State::InDecimal,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INDECIMAL: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Float),
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InDecimal,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InVerVersion,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'e',
        A_PUSH,
        State::InMantissaFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'E',
        A_PUSH,
        State::InMantissaFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Float),
        Special::None,
    ),
];

const ACT_INVERVERSION: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_RERUN,
        State::InSVerVersion,
        None,
        Special::VerVersion,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INSVERVERSION: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_BINGO | A_CLRALL,
        State::InUnsignedInt,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(Class::Always, 0, A_NEXT, State::Null, None, Special::None),
];

const ACT_INVERSIONFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_CLEAR,
        State::InVersion,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INVERSION: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Version),
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InVersion,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InVersionFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Version),
        Special::None,
    ),
];

const ACT_INMANTISSAFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_CLEAR,
        State::InMantissa,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'+',
        A_NEXT,
        State::InMantissaSign,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_NEXT,
        State::InMantissaSign,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INMANTISSASIGN: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_CLEAR,
        State::InMantissa,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INMANTISSA: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Sfloat),
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InMantissa,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::Sfloat),
        Special::None,
    ),
];

const ACT_INXMLENTITYFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'#',
        A_NEXT,
        State::InXMLEntityNumFirst,
        None,
        Special::None,
    ),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InXMLEntity,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b':',
        A_NEXT,
        State::InXMLEntity,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'_',
        A_NEXT,
        State::InXMLEntity,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INXMLENTITY: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Alnum,
        0,
        A_NEXT,
        State::InXMLEntity,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b':',
        A_NEXT,
        State::InXMLEntity,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'_',
        A_NEXT,
        State::InXMLEntity,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_NEXT,
        State::InXMLEntity,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_NEXT,
        State::InXMLEntity,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b';',
        A_NEXT,
        State::InXMLEntityEnd,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INXMLENTITYNUMFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'x',
        A_NEXT,
        State::InXMLEntityHexNumFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'X',
        A_NEXT,
        State::InXMLEntityHexNumFirst,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InXMLEntityNum,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INXMLENTITYNUM: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InXMLEntityNum,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b';',
        A_NEXT,
        State::InXMLEntityEnd,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INXMLENTITYHEXNUMFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Xdigit,
        0,
        A_NEXT,
        State::InXMLEntityHexNum,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INXMLENTITYHEXNUM: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Xdigit,
        0,
        A_NEXT,
        State::InXMLEntityHexNum,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b';',
        A_NEXT,
        State::InXMLEntityEnd,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INXMLENTITYEND: &[Item] = &[item(
    Class::Always,
    0,
    A_BINGO | A_CLEAR,
    State::Base,
    Some(TokenType::Entity),
    Special::None,
)];

const ACT_INTAGFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'/',
        A_PUSH,
        State::InTagCloseFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'!',
        A_PUSH,
        State::InCommentFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'?',
        A_PUSH,
        State::InXMLBegin,
        None,
        Special::None,
    ),
    item(
        Class::Asclet,
        0,
        A_PUSH,
        State::InTagName,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b':',
        A_PUSH,
        State::InTagName,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'_',
        A_PUSH,
        State::InTagName,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INXMLBEGIN: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Eq, b'x', A_NEXT, State::InTag, None, Special::None),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INTAGCLOSEFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InTagName,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INTAGNAME: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'/',
        A_NEXT,
        State::InTagBeginEnd,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'>',
        A_NEXT,
        State::InTagEnd,
        None,
        Special::Tags,
    ),
    item(Class::Space, 0, A_NEXT, State::InTag, None, Special::Tags),
    item(Class::Alnum, 0, A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b':', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'_', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'.', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'-', A_NEXT, State::Null, None, Special::None),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INTAGBEGINEND: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'>',
        A_NEXT,
        State::InTagEnd,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INTAG: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'>',
        A_NEXT,
        State::InTagEnd,
        None,
        Special::Tags,
    ),
    item(
        Class::Eq,
        b'\'',
        A_NEXT,
        State::InTagEscapeK,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'"',
        A_NEXT,
        State::InTagEscapeKK,
        None,
        Special::None,
    ),
    item(Class::Asclet, 0, A_NEXT, State::Null, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'=', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'-', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'_', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'#', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'/', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b':', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'.', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'&', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'?', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'%', A_NEXT, State::Null, None, Special::None),
    item(Class::Eq, b'~', A_NEXT, State::Null, None, Special::None),
    item(Class::Space, 0, A_NEXT, State::Null, None, Special::Tags),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INTAGESCAPEK: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'\\',
        A_PUSH,
        State::InTagBackSleshed,
        None,
        Special::None,
    ),
    item(Class::Eq, b'\'', A_NEXT, State::InTag, None, Special::None),
    item(
        Class::Always,
        0,
        A_NEXT,
        State::InTagEscapeK,
        None,
        Special::None,
    ),
];

const ACT_INTAGESCAPEKK: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'\\',
        A_PUSH,
        State::InTagBackSleshed,
        None,
        Special::None,
    ),
    item(Class::Eq, b'"', A_NEXT, State::InTag, None, Special::None),
    item(
        Class::Always,
        0,
        A_NEXT,
        State::InTagEscapeKK,
        None,
        Special::None,
    ),
];

const ACT_INTAGBACKSLESHED: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Always, 0, A_MERGE, State::Null, None, Special::None),
];

const ACT_INTAGEND: &[Item] = &[item(
    Class::Always,
    0,
    A_BINGO | A_CLRALL,
    State::Base,
    Some(TokenType::Tag),
    Special::None,
)];

const ACT_INCOMMENTFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'-',
        A_NEXT,
        State::InCommentLast,
        None,
        Special::None,
    ),
    item(Class::Eq, b'D', A_NEXT, State::InTag, None, Special::None),
    item(Class::Eq, b'd', A_NEXT, State::InTag, None, Special::None),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INCOMMENTLAST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'-',
        A_NEXT,
        State::InComment,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INCOMMENT: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'-',
        A_NEXT,
        State::InCloseCommentFirst,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_NEXT, State::Null, None, Special::None),
];

const ACT_INCLOSECOMMENTFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'-',
        A_NEXT,
        State::InCloseCommentLast,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_NEXT,
        State::InComment,
        None,
        Special::None,
    ),
];

const ACT_INCLOSECOMMENTLAST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Eq, b'-', A_NEXT, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'>',
        A_NEXT,
        State::InCommentEnd,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_NEXT,
        State::InComment,
        None,
        Special::None,
    ),
];

const ACT_INCOMMENTEND: &[Item] = &[item(
    Class::Always,
    0,
    A_BINGO | A_CLRALL,
    State::Base,
    Some(TokenType::Tag),
    Special::None,
)];

const ACT_INHOSTFIRSTDOMAIN: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InHostDomainSecond,
        None,
        Special::None,
    ),
    item(Class::Digit, 0, A_NEXT, State::InHost, None, Special::None),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INHOSTDOMAINSECOND: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InHostDomain,
        None,
        Special::None,
    ),
    item(Class::Digit, 0, A_PUSH, State::InHost, None, Special::None),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'_',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InHostFirstDomain,
        None,
        Special::None,
    ),
    item(Class::Eq, b'@', A_PUSH, State::InEmail, None, Special::None),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INHOSTDOMAIN: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO | A_CLRALL,
        State::Base,
        Some(TokenType::Host),
        Special::None,
    ),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InHostDomain,
        None,
        Special::None,
    ),
    item(Class::Digit, 0, A_PUSH, State::InHost, None, Special::None),
    item(
        Class::Eq,
        b':',
        A_PUSH,
        State::InPortFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'_',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InHostFirstDomain,
        None,
        Special::None,
    ),
    item(Class::Eq, b'@', A_PUSH, State::InEmail, None, Special::None),
    item(Class::Digit, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::StopHost,
        0,
        A_BINGO | A_CLRALL,
        State::InURLPathStart,
        Some(TokenType::Host),
        Special::None,
    ),
    item(Class::Eq, b'/', A_PUSH, State::InFURL, None, Special::None),
    item(
        Class::Always,
        0,
        A_BINGO | A_CLRALL,
        State::Base,
        Some(TokenType::Host),
        Special::None,
    ),
];

const ACT_INPORTFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::InPort, None, Special::None),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INPORT: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO | A_CLRALL,
        State::Base,
        Some(TokenType::Host),
        Special::None,
    ),
    item(Class::Digit, 0, A_NEXT, State::InPort, None, Special::None),
    item(
        Class::StopHost,
        0,
        A_BINGO | A_CLRALL,
        State::InURLPathStart,
        Some(TokenType::Host),
        Special::None,
    ),
    item(Class::Eq, b'/', A_PUSH, State::InFURL, None, Special::None),
    item(
        Class::Always,
        0,
        A_BINGO | A_CLRALL,
        State::Base,
        Some(TokenType::Host),
        Special::None,
    ),
];

const ACT_INHOSTFIRSTAN: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::InHost, None, Special::None),
    item(Class::Asclet, 0, A_NEXT, State::InHost, None, Special::None),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INHOST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::InHost, None, Special::None),
    item(Class::Asclet, 0, A_NEXT, State::InHost, None, Special::None),
    item(Class::Eq, b'@', A_PUSH, State::InEmail, None, Special::None),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InHostFirstDomain,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'_',
        A_PUSH,
        State::InHostFirstAN,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INEMAIL: &[Item] = &[
    item(Class::StopHost, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Host,
        0,
        A_BINGO | A_CLRALL,
        State::Base,
        Some(TokenType::Email),
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INFILEFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Asclet, 0, A_NEXT, State::InFile, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::InFile, None, Special::None),
    item(
        Class::Eq,
        b'.',
        A_NEXT,
        State::InPathFirst,
        None,
        Special::None,
    ),
    item(Class::Eq, b'_', A_NEXT, State::InFile, None, Special::None),
    item(
        Class::Eq,
        b'~',
        A_PUSH,
        State::InFileTwiddle,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INFILETWIDDLE: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Asclet, 0, A_NEXT, State::InFile, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::InFile, None, Special::None),
    item(Class::Eq, b'_', A_NEXT, State::InFile, None, Special::None),
    item(
        Class::Eq,
        b'/',
        A_NEXT,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INPATHFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Asclet, 0, A_NEXT, State::InFile, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::InFile, None, Special::None),
    item(Class::Eq, b'_', A_NEXT, State::InFile, None, Special::None),
    item(
        Class::Eq,
        b'.',
        A_NEXT,
        State::InPathSecond,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'/',
        A_NEXT,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INPATHFIRSTFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'.',
        A_NEXT,
        State::InPathSecond,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'/',
        A_NEXT,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INPATHSECOND: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO | A_CLEAR,
        State::Base,
        Some(TokenType::File),
        Special::None,
    ),
    item(
        Class::Eq,
        b'/',
        A_NEXT | A_PUSH,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'/',
        A_BINGO | A_CLEAR,
        State::Base,
        Some(TokenType::File),
        Special::None,
    ),
    item(
        Class::Space,
        0,
        A_BINGO | A_CLEAR,
        State::Base,
        Some(TokenType::File),
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INFILE: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::File),
        Special::None,
    ),
    item(Class::Asclet, 0, A_NEXT, State::InFile, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::InFile, None, Special::None),
    item(
        Class::Eq,
        b'.',
        A_PUSH,
        State::InFileNext,
        None,
        Special::None,
    ),
    item(Class::Eq, b'_', A_NEXT, State::InFile, None, Special::None),
    item(Class::Eq, b'-', A_NEXT, State::InFile, None, Special::None),
    item(
        Class::Eq,
        b'/',
        A_PUSH,
        State::InFileFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::File),
        Special::None,
    ),
];

const ACT_INFILENEXT: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Asclet,
        0,
        A_CLEAR,
        State::InFile,
        None,
        Special::None,
    ),
    item(Class::Digit, 0, A_CLEAR, State::InFile, None, Special::None),
    item(Class::Eq, b'_', A_CLEAR, State::InFile, None, Special::None),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INURLPATHFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::UrlChar,
        0,
        A_NEXT,
        State::InURLPath,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INURLPATHSTART: &[Item] = &[item(
    Class::Always,
    0,
    A_NEXT,
    State::InURLPath,
    None,
    Special::None,
)];

const ACT_INURLPATH: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::UrlPath),
        Special::None,
    ),
    item(
        Class::UrlChar,
        0,
        A_NEXT,
        State::InURLPath,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::UrlPath),
        Special::None,
    ),
];

const ACT_INFURL: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::UrlPath,
        0,
        A_BINGO | A_CLRALL,
        State::Base,
        Some(TokenType::Url),
        Special::Furl,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INPROTOCOLFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'/',
        A_NEXT,
        State::InProtocolSecond,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INPROTOCOLSECOND: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Eq,
        b'/',
        A_NEXT,
        State::InProtocolEnd,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INPROTOCOLEND: &[Item] = &[item(
    Class::Always,
    0,
    A_BINGO | A_CLRALL,
    State::Base,
    Some(TokenType::Protocol),
    Special::None,
)];

const ACT_INHYPHENASCIIWORDFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InHyphenAsciiWord,
        None,
        Special::None,
    ),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenWord,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InHyphenDigitLookahead,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INHYPHENASCIIWORD: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO | A_CLRALL,
        State::InParseHyphen,
        Some(TokenType::Asciihword),
        Special::Hyphen,
    ),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InHyphenAsciiWord,
        None,
        Special::None,
    ),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenWord,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InHyphenWord,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InHyphenNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHyphenAsciiWordFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO | A_CLRALL,
        State::InParseHyphen,
        Some(TokenType::Asciihword),
        Special::Hyphen,
    ),
];

const ACT_INHYPHENWORDFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenWord,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InHyphenDigitLookahead,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INHYPHENWORD: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO | A_CLRALL,
        State::InParseHyphen,
        Some(TokenType::Hword),
        Special::Hyphen,
    ),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenWord,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InHyphenWord,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InHyphenNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHyphenWordFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO | A_CLRALL,
        State::InParseHyphen,
        Some(TokenType::Hword),
        Special::Hyphen,
    ),
];

const ACT_INHYPHENNUMWORDFIRST: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InHyphenDigitLookahead,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INHYPHENNUMWORD: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO | A_CLRALL,
        State::InParseHyphen,
        Some(TokenType::Numhword),
        Special::Hyphen,
    ),
    item(
        Class::Alnum,
        0,
        A_NEXT,
        State::InHyphenNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InHyphenNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InHyphenNumWordFirst,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO | A_CLRALL,
        State::InParseHyphen,
        Some(TokenType::Numhword),
        Special::Hyphen,
    ),
];

const ACT_INHYPHENDIGITLOOKAHEAD: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InHyphenDigitLookahead,
        None,
        Special::None,
    ),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenNumWord,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InHyphenNumWord,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INPARSEHYPHEN: &[Item] = &[
    item(Class::Eof, 0, A_RERUN, State::Base, None, Special::None),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InHyphenAsciiWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_PUSH,
        State::InHyphenUnsignedInt,
        None,
        Special::None,
    ),
    item(
        Class::Eq,
        b'-',
        A_PUSH,
        State::InParseHyphenHyphen,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_RERUN, State::Base, None, Special::None),
];

const ACT_INPARSEHYPHENHYPHEN: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(
        Class::Alnum,
        0,
        A_BINGO | A_CLEAR,
        State::InParseHyphen,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_BINGO | A_CLEAR,
        State::InParseHyphen,
        Some(TokenType::Blank),
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

const ACT_INHYPHENWORDPART: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::HwordPart),
        Special::None,
    ),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InHyphenWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InHyphenNumWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::InParseHyphen,
        Some(TokenType::HwordPart),
        Special::None,
    ),
];

const ACT_INHYPHENASCIIWORDPART: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::HwordAsciipart),
        Special::None,
    ),
    item(
        Class::Asclet,
        0,
        A_NEXT,
        State::InHyphenAsciiWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Alpha,
        0,
        A_NEXT,
        State::InHyphenWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InHyphenWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Digit,
        0,
        A_NEXT,
        State::InHyphenNumWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::InParseHyphen,
        Some(TokenType::HwordAsciipart),
        Special::None,
    ),
];

const ACT_INHYPHENNUMWORDPART: &[Item] = &[
    item(
        Class::Eof,
        0,
        A_BINGO,
        State::Base,
        Some(TokenType::HwordNumpart),
        Special::None,
    ),
    item(
        Class::Alnum,
        0,
        A_NEXT,
        State::InHyphenNumWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_NEXT,
        State::InHyphenNumWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Always,
        0,
        A_BINGO,
        State::InParseHyphen,
        Some(TokenType::HwordNumpart),
        Special::None,
    ),
];

const ACT_INHYPHENUNSIGNEDINT: &[Item] = &[
    item(Class::Eof, 0, A_POP, State::Null, None, Special::None),
    item(Class::Digit, 0, A_NEXT, State::Null, None, Special::None),
    item(
        Class::Alpha,
        0,
        A_CLEAR,
        State::InHyphenNumWordPart,
        None,
        Special::None,
    ),
    item(
        Class::Special,
        0,
        A_CLEAR,
        State::InHyphenNumWordPart,
        None,
        Special::None,
    ),
    item(Class::Always, 0, A_POP, State::Null, None, Special::None),
];

pub(super) fn actions(state: State) -> &'static [Item] {
    match state {
        State::Base => ACT_BASE,
        State::InNumWord => ACT_INNUMWORD,
        State::InAsciiWord => ACT_INASCIIWORD,
        State::InWord => ACT_INWORD,
        State::InUnsignedInt => ACT_INUNSIGNEDINT,
        State::InSignedIntFirst => ACT_INSIGNEDINTFIRST,
        State::InSignedInt => ACT_INSIGNEDINT,
        State::InSpace => ACT_INSPACE,
        State::InUDecimalFirst => ACT_INUDECIMALFIRST,
        State::InUDecimal => ACT_INUDECIMAL,
        State::InDecimalFirst => ACT_INDECIMALFIRST,
        State::InDecimal => ACT_INDECIMAL,
        State::InVerVersion => ACT_INVERVERSION,
        State::InSVerVersion => ACT_INSVERVERSION,
        State::InVersionFirst => ACT_INVERSIONFIRST,
        State::InVersion => ACT_INVERSION,
        State::InMantissaFirst => ACT_INMANTISSAFIRST,
        State::InMantissaSign => ACT_INMANTISSASIGN,
        State::InMantissa => ACT_INMANTISSA,
        State::InXMLEntityFirst => ACT_INXMLENTITYFIRST,
        State::InXMLEntity => ACT_INXMLENTITY,
        State::InXMLEntityNumFirst => ACT_INXMLENTITYNUMFIRST,
        State::InXMLEntityNum => ACT_INXMLENTITYNUM,
        State::InXMLEntityHexNumFirst => ACT_INXMLENTITYHEXNUMFIRST,
        State::InXMLEntityHexNum => ACT_INXMLENTITYHEXNUM,
        State::InXMLEntityEnd => ACT_INXMLENTITYEND,
        State::InTagFirst => ACT_INTAGFIRST,
        State::InXMLBegin => ACT_INXMLBEGIN,
        State::InTagCloseFirst => ACT_INTAGCLOSEFIRST,
        State::InTagName => ACT_INTAGNAME,
        State::InTagBeginEnd => ACT_INTAGBEGINEND,
        State::InTag => ACT_INTAG,
        State::InTagEscapeK => ACT_INTAGESCAPEK,
        State::InTagEscapeKK => ACT_INTAGESCAPEKK,
        State::InTagBackSleshed => ACT_INTAGBACKSLESHED,
        State::InTagEnd => ACT_INTAGEND,
        State::InCommentFirst => ACT_INCOMMENTFIRST,
        State::InCommentLast => ACT_INCOMMENTLAST,
        State::InComment => ACT_INCOMMENT,
        State::InCloseCommentFirst => ACT_INCLOSECOMMENTFIRST,
        State::InCloseCommentLast => ACT_INCLOSECOMMENTLAST,
        State::InCommentEnd => ACT_INCOMMENTEND,
        State::InHostFirstDomain => ACT_INHOSTFIRSTDOMAIN,
        State::InHostDomainSecond => ACT_INHOSTDOMAINSECOND,
        State::InHostDomain => ACT_INHOSTDOMAIN,
        State::InPortFirst => ACT_INPORTFIRST,
        State::InPort => ACT_INPORT,
        State::InHostFirstAN => ACT_INHOSTFIRSTAN,
        State::InHost => ACT_INHOST,
        State::InEmail => ACT_INEMAIL,
        State::InFileFirst => ACT_INFILEFIRST,
        State::InFileTwiddle => ACT_INFILETWIDDLE,
        State::InPathFirst => ACT_INPATHFIRST,
        State::InPathFirstFirst => ACT_INPATHFIRSTFIRST,
        State::InPathSecond => ACT_INPATHSECOND,
        State::InFile => ACT_INFILE,
        State::InFileNext => ACT_INFILENEXT,
        State::InURLPathFirst => ACT_INURLPATHFIRST,
        State::InURLPathStart => ACT_INURLPATHSTART,
        State::InURLPath => ACT_INURLPATH,
        State::InFURL => ACT_INFURL,
        State::InProtocolFirst => ACT_INPROTOCOLFIRST,
        State::InProtocolSecond => ACT_INPROTOCOLSECOND,
        State::InProtocolEnd => ACT_INPROTOCOLEND,
        State::InHyphenAsciiWordFirst => ACT_INHYPHENASCIIWORDFIRST,
        State::InHyphenAsciiWord => ACT_INHYPHENASCIIWORD,
        State::InHyphenWordFirst => ACT_INHYPHENWORDFIRST,
        State::InHyphenWord => ACT_INHYPHENWORD,
        State::InHyphenNumWordFirst => ACT_INHYPHENNUMWORDFIRST,
        State::InHyphenNumWord => ACT_INHYPHENNUMWORD,
        State::InHyphenDigitLookahead => ACT_INHYPHENDIGITLOOKAHEAD,
        State::InParseHyphen => ACT_INPARSEHYPHEN,
        State::InParseHyphenHyphen => ACT_INPARSEHYPHENHYPHEN,
        State::InHyphenWordPart => ACT_INHYPHENWORDPART,
        State::InHyphenAsciiWordPart => ACT_INHYPHENASCIIWORDPART,
        State::InHyphenNumWordPart => ACT_INHYPHENNUMWORDPART,
        State::InHyphenUnsignedInt => ACT_INHYPHENUNSIGNEDINT,
        State::Null => &[],
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PredictBox - binary prediction markets in native BOT with a creator bond and dispute window.
/// Parimutuel: winners split the whole pool pro rata. No oracle; the creator proposes, anyone can dispute
/// by matching the bond, a single arbiter settles disputes, and every stuck path ends in refunds.
contract PredictBox {
    enum Outcome { None, Yes, No, Invalid }
    enum Status { Open, Proposed, Disputed, Resolved }

    struct Market {
        address creator;
        uint64 closeTime;      // betting ends
        uint64 proposedAt;
        uint64 disputedAt;
        Status status;
        Outcome proposed;
        Outcome result;        // set when Resolved
        uint128 bond;          // creator bond (also the dispute bond)
        address disputer;
        uint128 yesPool;
        uint128 noPool;
        uint128 feePool;       // fees skimmed at resolution (informational)
        string question;
    }

    uint256 public constant MIN_BOND = 0.1 ether;
    uint256 public constant MIN_BET = 0.001 ether;
    uint64 public constant PROPOSE_WINDOW = 3 days;   // creator must propose within this after close
    uint64 public constant DISPUTE_WINDOW = 1 days;   // anyone may dispute within this after a proposal
    uint64 public constant ARBITER_TIMEOUT = 7 days;  // undecided disputes become Invalid
    uint256 public constant CREATOR_FEE_BPS = 100;    // 1% of pool to creator
    uint256 public constant PROTOCOL_FEE_BPS = 100;   // 1% of pool to treasury
    uint256 private constant BPS = 10_000;

    address public arbiter;
    address public treasury;
    uint256 public marketCount;
    mapping(uint256 => Market) internal _m;
    mapping(uint256 => mapping(address => uint128[2])) public stakes; // [yes, no]
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(address => uint256) public credits; // pull-payment balance (bonds, fees)

    event MarketCreated(uint256 indexed id, address indexed creator, uint64 closeTime, uint256 bond, string question);
    event Bet(uint256 indexed id, address indexed user, bool yes, uint256 amount);
    event Proposed(uint256 indexed id, Outcome outcome);
    event Disputed(uint256 indexed id, address indexed disputer);
    event Resolved(uint256 indexed id, Outcome result, bool disputed);
    event Claimed(uint256 indexed id, address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event ArbiterChanged(address arbiter);

    error BadParam(); error WrongState(); error TooEarly(); error TooLate(); error NotAllowed(); error Nothing(); error Failed();

    uint256 private _lock = 1;
    modifier nonReentrant() { if (_lock != 1) revert Failed(); _lock = 2; _; _lock = 1; }

    constructor(address _arbiter, address _treasury) {
        if (_arbiter == address(0) || _treasury == address(0)) revert BadParam();
        arbiter = _arbiter; treasury = _treasury;
    }

    function setArbiter(address a) external {
        if (msg.sender != arbiter || a == address(0)) revert NotAllowed();
        arbiter = a; emit ArbiterChanged(a);
    }

    // ---------------------------------------------------------------- lifecycle
    function createMarket(string calldata question, uint64 closeTime) external payable returns (uint256 id) {
        if (msg.value < MIN_BOND || msg.value > type(uint128).max) revert BadParam();
        if (bytes(question).length == 0 || bytes(question).length > 280) revert BadParam();
        if (closeTime < block.timestamp + 1 hours || closeTime > block.timestamp + 365 days) revert BadParam();
        id = ++marketCount;
        Market storage m = _m[id];
        m.creator = msg.sender; m.closeTime = closeTime; m.bond = uint128(msg.value); m.question = question;
        emit MarketCreated(id, msg.sender, closeTime, msg.value, question);
    }

    function bet(uint256 id, bool yes) external payable {
        Market storage m = _m[id];
        if (m.creator == address(0)) revert BadParam();
        if (m.status != Status.Open || block.timestamp >= m.closeTime) revert TooLate();
        if (msg.sender == m.creator) revert NotAllowed(); // creator resolves, so cannot trade
        if (msg.value < MIN_BET || msg.value > type(uint128).max) revert BadParam();
        uint128 v = uint128(msg.value);
        if (yes) { m.yesPool += v; stakes[id][msg.sender][0] += v; }
        else { m.noPool += v; stakes[id][msg.sender][1] += v; }
        emit Bet(id, msg.sender, yes, v);
    }

    function propose(uint256 id, Outcome o) external {
        Market storage m = _m[id];
        if (msg.sender != m.creator) revert NotAllowed();
        if (m.status != Status.Open) revert WrongState();
        if (block.timestamp < m.closeTime) revert TooEarly();
        if (block.timestamp > m.closeTime + PROPOSE_WINDOW) revert TooLate();
        if (o == Outcome.None) revert BadParam();
        m.status = Status.Proposed; m.proposed = o; m.proposedAt = uint64(block.timestamp);
        emit Proposed(id, o);
    }

    function dispute(uint256 id) external payable {
        Market storage m = _m[id];
        if (m.status != Status.Proposed) revert WrongState();
        if (block.timestamp >= m.proposedAt + DISPUTE_WINDOW) revert TooLate();
        if (msg.value != m.bond) revert BadParam();
        m.status = Status.Disputed; m.disputer = msg.sender; m.disputedAt = uint64(block.timestamp);
        emit Disputed(id, msg.sender);
    }

    /// Undisputed proposal after the window.
    function finalize(uint256 id) external {
        Market storage m = _m[id];
        if (m.status != Status.Proposed) revert WrongState();
        if (block.timestamp < m.proposedAt + DISPUTE_WINDOW) revert TooEarly();
        credits[m.creator] += m.bond;
        _settle(id, m.proposed, false);
    }

    /// Arbiter decides a dispute. Agreeing with the creator slashes the disputer; anything else slashes the creator.
    function arbitrate(uint256 id, Outcome o) external {
        Market storage m = _m[id];
        if (msg.sender != arbiter) revert NotAllowed();
        if (m.status != Status.Disputed) revert WrongState();
        if (o == Outcome.None) revert BadParam();
        if (o == m.proposed) {
            credits[m.creator] += uint256(m.bond) * 2; // own bond back + disputer's bond
        } else {
            uint256 half = m.bond / 2;
            credits[m.disputer] += uint256(m.bond) + half; // own bond back + half of creator's
            credits[treasury] += uint256(m.bond) - half;
        }
        _settle(id, o, true);
    }

    /// Permissionless escape hatch: creator never proposed, or arbiter never decided. Everyone is refunded.
    function expire(uint256 id) external {
        Market storage m = _m[id];
        if (m.status == Status.Open) {
            if (block.timestamp <= m.closeTime + PROPOSE_WINDOW) revert TooEarly();
            credits[treasury] += m.bond; // creator abandoned the market: bond forfeited
        } else if (m.status == Status.Disputed) {
            if (block.timestamp <= m.disputedAt + ARBITER_TIMEOUT) revert TooEarly();
            credits[m.creator] += m.bond; credits[m.disputer] += m.bond; // nobody at fault known
        } else revert WrongState();
        _settle(id, Outcome.Invalid, m.status == Status.Disputed);
    }

    function _settle(uint256 id, Outcome o, bool disputed) internal {
        Market storage m = _m[id];
        uint256 win = o == Outcome.Yes ? m.yesPool : o == Outcome.No ? m.noPool : 0;
        uint256 lose = o == Outcome.Yes ? m.noPool : o == Outcome.No ? m.yesPool : 0;
        if (o != Outcome.Invalid && (win == 0 || lose == 0)) o = Outcome.Invalid; // one-sided market: refund
        m.status = Status.Resolved; m.result = o;
        if (o != Outcome.Invalid) {
            uint256 total = win + lose;
            uint256 cf = total * CREATOR_FEE_BPS / BPS; uint256 pf = total * PROTOCOL_FEE_BPS / BPS;
            credits[m.creator] += cf; credits[treasury] += pf; m.feePool = uint128(cf + pf);
        }
        emit Resolved(id, o, disputed);
    }

    // ---------------------------------------------------------------- payouts
    function payoutOf(uint256 id, address user) public view returns (uint256) {
        Market storage m = _m[id];
        if (m.status != Status.Resolved || claimed[id][user]) return 0;
        uint128[2] memory s = stakes[id][user];
        if (m.result == Outcome.Invalid) return uint256(s[0]) + s[1];
        uint256 total = uint256(m.yesPool) + m.noPool;
        uint256 prize = total - m.feePool;
        if (m.result == Outcome.Yes) return uint256(s[0]) * prize / m.yesPool;
        return uint256(s[1]) * prize / m.noPool;
    }

    function claim(uint256 id) external nonReentrant {
        uint256 amt = payoutOf(id, msg.sender);
        if (amt == 0) revert Nothing();
        claimed[id][msg.sender] = true;
        emit Claimed(id, msg.sender, amt);
        _send(msg.sender, amt);
    }

    function withdraw() external nonReentrant {
        uint256 amt = credits[msg.sender];
        if (amt == 0) revert Nothing();
        credits[msg.sender] = 0;
        emit Withdrawn(msg.sender, amt);
        _send(msg.sender, amt);
    }

    function _send(address to, uint256 amt) private { (bool ok, ) = to.call{value: amt}(""); if (!ok) revert Failed(); }

    // ---------------------------------------------------------------- views
    function getMarket(uint256 id) external view returns (Market memory) { return _m[id]; }
}

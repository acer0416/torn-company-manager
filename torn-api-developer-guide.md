# Torn City API — Complete Developer Reference

**V1 + V2** | Generated 2026-05-10

**Source:** api.torn.com (V1) | api.torn.com/v2/ (V2)

**OpenAPI Spec:** https://www.torn.com/swagger/openapi.json

## 1. OVERVIEW

The Torn API provides read-only access to game data. All requests
require an API key as a query parameter.

Two API versions exist:

  V1 (Selection-based):
    GET /{category}/?selections={sel1},{sel2}&key={KEY}
    → Returns multiple selections in one request
    → Flat response object
    → Available at api.torn.com

  V2 (Path-based):
    GET /v2/{category}/{selection}?key={KEY}
    → One selection per request
    → Nested response with _metadata
    → OpenAPI 3.1.0 spec available

Recommendation: Use V2 for new projects (structured, typed).
Use V1 when you need multiple selections in one call.

## 2. AUTHENTICATION & RATE LIMITS

Authentication:
  All requests require &key={YOUR_16_CHAR_API_KEY}
  Get your key at: https://www.torn.com/preferences.php#tab=api

Rate Limits:
  100 requests/minute per user (across all keys)
  Service cache: up to 30s (bypass with &timestamp={unix_time})
  Global cache on some selections (cannot bypass)

Globally cached selections (all users get same data):
  market.itemmarket, market.properties, market.rentals,
  company.companies, user.bazaar, torn.bounties, user.bounties

Access Levels:
  Public    — No key needed for some endpoints
  Minimal   — Basic access
  Limited   — Extended access
  Full      — Complete access

## 3. ERROR CODES

| Code | Meaning |
|------|---------|
| 0 | Unknown error |
| 1 | Key is empty |
| 2 | Incorrect key / wrong format |
| 3 | Wrong type (bad category) |
| 4 | Wrong fields (bad selection) |
| 5 | Too many requests (max 100/min) |
| 6 | Incorrect ID |
| 7 | Incorrect ID-entity relation (private data) |
| 8 | IP block (abuse) |
| 9 | API system disabled |
| 10 | Key owner in federal jail |
| 11 | Key change error (60s cooldown) |
| 12 | Key read error |
| 13 | Key disabled (owner inactive >7 days) |
| 14 | Daily read limit reached |
| 15 | Temporary error (testing) |
| 16 | Access level too low |
| 17 | Backend error (retry) |
| 18 | Key paused by owner |
| 19 | Must migrate to crimes 2.0 |
| 20 | Race not yet finished |
| 21 | Incorrect category value |
| 22 | Selection only in V1 |
| 23 | Selection only in V2 |
| 24 | Closed temporarily |
| 25 | Invalid stat requested |
| 26 | Only category or stats can be requested |
| 27 | Must migrate to organized crimes 2.0 |
| 28 | Incorrect log ID |
| 29 | Category not for interaction logs |

## 4. QUICK EXAMPLES

```
# V1: Get multiple selections in one call
curl "https://api.torn.com/user/?selections=basic,attacks,travel&key=YOUR_KEY"
```

```
# V2: Get a specific selection
curl "https://api.torn.com/v2/user/basic?key=YOUR_KEY"
```

```
# V2: Get another player's data
curl "https://api.torn.com/v2/user/12345/basic?key=YOUR_KEY"
```

```
# V1: Get global game data
curl "https://api.torn.com/torn/?selections=items,dirtybombs&key=YOUR_KEY"
```

```
# V2: Get all dirty bombs (全服)
curl "https://api.torn.com/v2/torn/dirtybombs?key=YOUR_KEY"
```

```
# Bypass cache with timestamp
curl "https://api.torn.com/user/?selections=basic&key=YOUR_KEY&timestamp=$(date +%s)"
```

```
# V1: Faction warfare (ranked/territory/raid/chain/dirtybomb)
curl "https://api.torn.com/faction/warfare?cat=db&key=YOUR_KEY"
```

## 5. COMMON PATTERNS

# Check dirty bomb status (全服)
# Returned array; entries with detonated=0 → bomb active
GET /torn/?selections=dirtybombs    (V1)
GET /v2/torn/dirtybombs              (V2)

# Check if you can travel
GET /user/?selections=travel         (V1)
GET /v2/user/travel                   (V2)
  → time_left=0 means not currently traveling

# Check user status
GET /user/?selections=basic           (V1)
GET /v2/user/basic                     (V2)
  → status.state: Okay|Traveling|Hospital|Jail|Abroad|Federal

# Get item market prices
GET /market/?selections=pointsmarket  (V1)
GET /v2/market/pointsmarket            (V2)

# Get city shop inventory
GET /torn/?selections=cityshops       (V1)
GET /v2/torn/cityshops                 (V2)

# Get another player's profile
GET /user/{id}?selections=basic,profile  (V1)
GET /v2/user/{id}/basic                   (V2)

# Get faction data
GET /faction/?selections=basic,members   (V1)
GET /v2/faction/basic                     (V2)

## 6. CATEGORIES & ENDPOINTS

────────────────────────────────────────────────────────────────────────
  USER
  V1: /user/?selections=...  (71 selections)
  V2: /v2/user/...            (79 endpoints)
  Player data (yours or others by ID)
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  ammo                           ?         
  attacks                        Full      
  attacksfull                    Full      
  bars                           Minimal   
  basic                          Minimal   
  battlestats                    Full      
  bazaar                         Minimal   
  bounties                       Minimal   
  calendar                       Minimal   
  casino                         Minimal   
  competition                    Minimal   
  cooldowns                      Minimal   
  crimes                         Full      
  criminalrecord                 Minimal   
  discord                        Minimal   
  display                        Minimal   
  education                      Minimal   
  enlistedcars                   Minimal   
  equipment                      Minimal   
  events                         Minimal   
  faction                        Minimal   
  factionbalance                 Minimal   
  forumfeed                      Minimal   
  forumfriends                   Minimal   
  forumposts                     Minimal   
  forumsubscribedthreads         Minimal   
  forumthreads                   Minimal   
  gym                            Minimal   
  hof                            Public    
  honors                         Minimal   
  icons                          Minimal   
  inventory                      Full      
  itemmarket                     Minimal   
  job                            Minimal   
  jobpoints                      Minimal   
  jobranks                       Minimal   
  list                           Minimal   
  log                            Full      
  lookup                         Public    
  medals                         Minimal   
  merits                         Full      
  messages                       Full      
  missions                       Minimal   
  money                          Minimal   
  networth                       Full      
  newevents                      Minimal   
  newmessages                    Minimal   
  notifications                  Minimal   
  organizedcrime                 Minimal   
  organizedcrimes                Minimal   
  perks                          Minimal   
  personalstats                  Full      
  profile                        Public    
  properties                     Minimal   
  property                       Minimal   
  publicstatus                   Minimal   
  races                          Minimal   
  racingrecords                  Minimal   
  refills                        Minimal   
  reports                        Full      
  revives                        Full      
  revivesfull                    Full      
  skills                         Minimal   
  stocks                         Minimal   
  timestamp                      Public    
  trade                          Minimal   
  trades                         Minimal   
  travel                         Minimal   
  virus                          Minimal   
  weaponexp                      Full      
  workstats                      Minimal   

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /user                                    Get any User selection
  GET     /user/ammo                               Get your ammo information
  GET     /user/attacks                            Get your detailed attacks
  GET     /user/attacksfull                        Get your simplified attacks
  GET     /user/bars                               Get your bars information
  GET     /user/basic                              Get your basic profile information
  GET     /user/battlestats                        Get your battlestats
  GET     /user/bounties                           Get bounties placed on you
  GET     /user/calendar                           Get your calendar events start time
  GET     /user/casino                             Get your casino streak & tokens
  GET     /user/competition                        Get your competition information
  GET     /user/cooldowns                          Get your cooldowns information
  GET     /user/discord                            Get your discord information
  GET     /user/education                          Get your education information
  GET     /user/enlistedcars                       Get your enlisted cars
  GET     /user/equipment                          Get your equipment & clothing
  GET     /user/events                             Get your events
  GET     /user/faction                            Get your faction information
  GET     /user/forumfeed                          Get updates on your threads and posts
  GET     /user/forumfriends                       Get updates on your friends' activity
  GET     /user/forumposts                         Get your posts
  GET     /user/forumsubscribedthreads             Get updates on threads you subscribed to
  GET     /user/forumthreads                       Get your threads
  GET     /user/hof                                Get your hall of fame rankings
  GET     /user/honors                             Get your achieved honors
  GET     /user/icons                              Get your icons information
  GET     /user/inventory                          Get your inventory
  GET     /user/itemmarket                         Get your item market listings
  GET     /user/itemmods                           Get your information about available item mods
  GET     /user/job                                Get your job information
  GET     /user/jobpoints                          Get your jobpoints
  GET     /user/jobranks                           Get your starter job positions
  GET     /user/list                               Get your friends, enemies or targets list
  GET     /user/log                                Get your logs
  GET     /user/lookup                             Get all available user selections
  GET     /user/medals                             Get your achieved medals
  GET     /user/merits                             Get your merits
  GET     /user/messages                           Get your messages
  GET     /user/missions                           Get your current missions information
  GET     /user/money                              Get your current wealth
  GET     /user/newevents                          Get your unseen events
  GET     /user/newmessages                        Get your unseen messages
  GET     /user/notifications                      Get your notifications
  GET     /user/organizedcrime                     Get your current ongoing organized crime
  GET     /user/organizedcrimes                    Get available slots for organized crimes with s...
  GET     /user/personalstats                      Get your personal stats
  GET     /user/profile                            Get your own profile
  GET     /user/properties                         Get your own properties
  GET     /user/property                           Get your current property
  GET     /user/races                              Get user races
  GET     /user/racingrecords                      Get your current racing records
  GET     /user/refills                            Get your refills information
  GET     /user/reports                            Get your reports
  GET     /user/revives                            Get your detailed revives
  GET     /user/revivesFull                        Get your simplified revives
  GET     /user/skills                             Get your skills
  GET     /user/stocks                             Get your stocks
  GET     /user/timestamp                          Get current server time
  GET     /user/trades                             Get your trades
  GET     /user/travel                             Get your travel information
  GET     /user/virus                              Get your virus coding information
  GET     /user/weaponexp                          Get your weapon experience information
  GET     /user/workstats                          Get your working stats
  GET     /user/{crimeId}/crimes                   Get your crime statistics
  GET     /user/{id}/basic                         Get basic profile information for a specific user
  GET     /user/{id}/bounties                      Get bounties placed on a specific user
  GET     /user/{id}/competition                   Get competition information for a specific player
  GET     /user/{id}/discord                       Get discord information for a specific user
  GET     /user/{id}/faction                       Get faction information for a specific player
  GET     /user/{id}/forumposts                    Get posts for a specific player
  GET     /user/{id}/forumthreads                  Get threads for a specific player
  GET     /user/{id}/hof                           Get hall of fame rankings for a specific player
  GET     /user/{id}/icons                         Get icons information for a specific player
  GET     /user/{id}/job                           Get job information for a specific player
  GET     /user/{id}/personalstats                 Get a player's personal stats
  GET     /user/{id}/profile                       Get profile information for a specific player
  GET     /user/{id}/properties                    Get specific user's properties
  GET     /user/{id}/property                      Get specific user's property
  GET     /user/{tradeId}/trade                    Get your detailed trade

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `user/?selections=ammo` | `/v2/user/ammo` |
| `user/?selections=attacks` | `/v2/user/attacks` |
| `user/?selections=attacksfull` | `/v2/user/attacksfull` |
| `user/?selections=bars` | `/v2/user/bars` |
| `user/?selections=basic` | `/v2/user/basic` |
| `user/?selections=battlestats` | `/v2/user/battlestats` |
| `user/?selections=bounties` | `/v2/user/bounties` |
| `user/?selections=calendar` | `/v2/user/calendar` |
| `user/?selections=casino` | `/v2/user/casino` |
| `user/?selections=competition` | `/v2/user/competition` |
| `user/?selections=cooldowns` | `/v2/user/cooldowns` |
| `user/?selections=discord` | `/v2/user/discord` |

────────────────────────────────────────────────────────────────────────
  FACTION
  V1: /faction/?selections=...  (53 selections)
  V2: /v2/faction/...            (46 endpoints)
  Faction data (yours or others by ID)
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  applications                   Minimal   
  armor                          Minimal   
  armorynews                     Minimal   
  attacknews                     Minimal   
  attacks                        Full      
  attacksfull                    Full      
  balance                        Minimal   
  basic                          Minimal   
  boosters                       Minimal   
  caches                         Minimal   
  cesium                         ?         
  chain                          Minimal   
  chainreport                    Minimal   
  chains                         Minimal   
  contributors                   Minimal   
  crime                          Minimal   
  crimeexp                       Minimal   
  crimenews                      Minimal   
  crimes                         Minimal   
  currency                       Minimal   
  donations                      Minimal   
  drugs                          Minimal   
  fundsnews                      Minimal   
  hof                            Minimal   
  lookup                         ?         
  mainnews                       Minimal   
  medical                        Minimal   
  members                        Minimal   
  membershipnews                 Minimal   
  news                           Minimal   
  positions                      Minimal   
  rackets                        Minimal   
  raidreport                     Minimal   
  raids                          Minimal   
  rankedwarreport                Minimal   
  rankedwars                     Minimal   
  reports                        Full      
  revives                        Minimal   
  revivesfull                    Minimal   
  search                         Minimal   
  stats                          Minimal   
  temporary                      Minimal   
  territory                      Minimal   
  territorynews                  Minimal   
  territoryownership             Minimal   
  territorywarreport             Minimal   
  territorywars                  Minimal   
  timestamp                      ?         
  upgrades                       Minimal   
  utilities                      Minimal   
  warfare                        Minimal   
  wars                           Minimal   
  weapons                        Minimal   

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /faction                                 Get any Faction selection
  GET     /faction/applications                    Get your faction's applications
  GET     /faction/attacks                         Get your faction's detailed attacks
  GET     /faction/attacksfull                     Get your faction's simplified attacks
  GET     /faction/balance                         Get your faction's & member's balance details
  GET     /faction/basic                           Get your faction's basic details
  GET     /faction/chain                           Get your faction's current chain
  GET     /faction/chainreport                     Get your faction's latest chain report
  GET     /faction/chains                          Get a list of your faction's completed chains
  GET     /faction/contributors                    Get your faction's challenge contributors
  GET     /faction/crimes                          Get your faction's organized crimes
  GET     /faction/hof                             Get your faction's hall of fame rankings.
  GET     /faction/lookup                          
  GET     /faction/members                         Get a list of your faction's members
  GET     /faction/news                            Get your faction's news details
  GET     /faction/positions                       Get your faction's positions details
  GET     /faction/rackets                         Get a list of current rackets
  GET     /faction/raids                           Get raids history for your faction
  GET     /faction/rankedwars                      Get ranked wars history for your faction
  GET     /faction/reports                         Get faction reports
  GET     /faction/revives                         Get your faction's detailed revives
  GET     /faction/revivesFull                     Get your faction's simplified revives
  GET     /faction/search                          Search factions by name or other criteria
  GET     /faction/stats                           Get your faction's challenges stats
  GET     /faction/territory                       Get a list of your faction's territories
  GET     /faction/territoryownership              Get a list territory ownership
  GET     /faction/territorywars                   Get territory wars history for your faction
  GET     /faction/timestamp                       Get current server time
  GET     /faction/upgrades                        Get your faction's upgrades
  GET     /faction/warfare                         Get faction warfare
  GET     /faction/wars                            Get your faction's wars & pacts details
  GET     /faction/{chainId}/chainreport           Get a chain report
  GET     /faction/{crimeId}/crime                 Get a specific organized crime
  GET     /faction/{id}/basic                      Get a faction's basic details
  GET     /faction/{id}/chain                      Get a faction's current chain
  GET     /faction/{id}/chains                     Get a list of a faction's completed chains
  GET     /faction/{id}/hof                        Get a faction's hall of fame rankings.
  GET     /faction/{id}/members                    Get a list of a faction's members
  GET     /faction/{id}/raids                      Get a faction's raids history
  GET     /faction/{id}/rankedwars                 Get a faction's ranked wars history
  GET     /faction/{id}/territory                  Get a list of a faction's territories
  GET     /faction/{id}/territorywars              Get a faction's territory wars history
  GET     /faction/{id}/wars                       Get a faction's wars & pacts details
  GET     /faction/{raidWarId}/raidreport          Get raid war details
  GET     /faction/{rankedWarId}/rankedwarreport   Get ranked war details
  GET     /faction/{territoryWarId}/territorywarreport Get territory war details

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `faction/?selections=applications` | `/v2/faction/applications` |
| `faction/?selections=attacks` | `/v2/faction/attacks` |
| `faction/?selections=attacksfull` | `/v2/faction/attacksfull` |
| `faction/?selections=balance` | `/v2/faction/balance` |
| `faction/?selections=basic` | `/v2/faction/basic` |
| `faction/?selections=chain` | `/v2/faction/chain` |
| `faction/?selections=chainreport` | `/v2/faction/chainreport` |
| `faction/?selections=chains` | `/v2/faction/chains` |
| `faction/?selections=contributors` | `/v2/faction/contributors` |

────────────────────────────────────────────────────────────────────────
  TORN
  V1: /torn/?selections=...  (51 selections)
  V2: /v2/torn/...            (33 endpoints)
  Global game data (items, stocks, dirtybombs, etc.)
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  attacklog                      Public    
  bank                           Public    
  bounties                       Public    
  calendar                       Public    
  cards                          Public    
  chainreport                    Public    
  cityshops                      Public    
  companies                      Public    
  competition                    Public    
  crimes                         Public    
  dirtybombs                     Public    
  education                      Public    
  elimination                    Public    
  eliminationattacks             Public    
  eliminationteam                Public    
  factionhof                     Public    
  factiontree                    Public    
  gyms                           Public    
  hof                            Public    
  honors                         Public    
  itemammo                       Public    
  itemdetails                    Public    
  itemmods                       Public    
  items                          Public    
  itemstats                      Public    
  logcategories                  Public    
  logtypes                       Public    
  lookup                         Public    
  medals                         Public    
  merits                         Public    
  organisedcrimes                Public    
  organizedcrimes                Public    
  pawnshop                       Public    
  pokertables                    Public    
  properties                     Public    
  rackets                        Public    
  raidreport                     ?         
  raids                          Public    
  rankedwarreport                Public    
  rankedwars                     Public    
  rockpaperscissors              Public    
  searchforcash                  Public    
  shoplifting                    Public    
  stats                          Public    
  stocks                         Public    
  subcrimes                      Public    
  territory                      Public    
  territorynames                 Public    
  territorywarreport             Public    
  territorywars                  Public    
  timestamp                      Public    

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /torn                                    Get any Torn selection
  GET     /torn/                                   Get all dirty bombs (global)
  GET     /torn/attacklog                          Get attack log details
  GET     /torn/bounties                           Get bounties
  GET     /torn/calendar                           Get calendar information
  GET     /torn/crimes                             Get crimes information
  GET     /torn/education                          Get education information
  GET     /torn/elimination                        Get current standings for all elimination teams
  GET     /torn/factionhof                         Get faction hall of fame positions for a specif...
  GET     /torn/factiontree                        Get full faction tree
  GET     /torn/hof                                Get player hall of fame positions for a specifi...
  GET     /torn/honors                             Get all honors
  GET     /torn/itemammo                           Get information about ammo
  GET     /torn/itemmods                           Get information about weapon upgrades
  GET     /torn/items                              Get information about items
  GET     /torn/logcategories                      Get available log categories
  GET     /torn/logtypes                           Get all available log ids
  GET     /torn/lookup                             Get all available torn selections
  GET     /torn/medals                             Get all medals
  GET     /torn/merits                             Get all merits
  GET     /torn/organizedcrimes                    Get organized crimes information
  GET     /torn/properties                         Get properties details
  GET     /torn/stocks                             Get all stocks
  GET     /torn/territory                          Get territory details
  GET     /torn/timestamp                          Get current server time
  GET     /torn/{crimeId}/subcrimes                Get Subcrimes information
  GET     /torn/{ids}/honors                       Get specific honors
  GET     /torn/{ids}/items                        Get information about items
  GET     /torn/{ids}/medals                       Get specific medals
  GET     /torn/{id}/eliminationteam               Get players in a specific elimination team
  GET     /torn/{id}/itemdetails                   Get information about a specific item
  GET     /torn/{logCategoryId}/logtypes           Get available log ids for a specific log category
  GET     /torn/{stockId}/stocks                   Get specific stock with chart history

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `torn/?selections=attacklog` | `/v2/torn/attacklog` |
| `torn/?selections=bounties` | `/v2/torn/bounties` |
| `torn/?selections=calendar` | `/v2/torn/calendar` |
| `torn/?selections=crimes` | `/v2/torn/crimes` |
| `torn/?selections=education` | `/v2/torn/education` |
| `torn/?selections=elimination` | `/v2/torn/elimination` |

────────────────────────────────────────────────────────────────────────
  MARKET
  V1: /market/?selections=...  (9 selections)
  V2: /v2/market/...            (11 endpoints)
  Market data (bazaar, point market, property listings)
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  auctionhouse                   Public    
  auctionhouselisting            Public    
  bazaar                         Public    
  itemmarket                     Public    
  lookup                         Public    
  pointsmarket                   Public    
  properties                     Public    
  rentals                        Public    
  timestamp                      Public    

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /market                                  Get any Market selection
  GET     /market/auctionhouse                     Get auction house listings
  GET     /market/bazaar                           Get bazaar directory
  GET     /market/lookup                           Get all available market selections
  GET     /market/timestamp                        Get current server time
  GET     /market/{id}/auctionhouse                Get specific item auction house listings
  GET     /market/{id}/auctionhouselisting         Get specific item auction house listings
  GET     /market/{id}/bazaar                      Get item specialized bazaar directory
  GET     /market/{id}/itemmarket                  Get item market listings
  GET     /market/{propertyTypeId}/properties      Get properties market listings
  GET     /market/{propertyTypeId}/rentals         Get properties rental listings

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `market/?selections=auctionhouse` | `/v2/market/auctionhouse` |
| `market/?selections=bazaar` | `/v2/market/bazaar` |
| `market/?selections=lookup` | `/v2/market/lookup` |
| `market/?selections=timestamp` | `/v2/market/timestamp` |

────────────────────────────────────────────────────────────────────────
  COMPANY
  V1: /company/?selections=...  (9 selections)
  V2: /v2/company/...            (9 endpoints)
  Company data (yours or others by ID)
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  applications                   Minimal   
  companies                      Public    
  detailed                       Minimal   
  employees                      Minimal   
  lookup                         Public    
  news                           Minimal   
  profile                        Minimal   
  stock                          Minimal   
  timestamp                      Public    

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /company                                 Get any Company selection
  GET     /company/applications                    Get your company's applications
  GET     /company/employees                       Get my company's employees
  GET     /company/lookup                          
  GET     /company/profile                         Get my company's profile
  GET     /company/stock                           Get your company's stock
  GET     /company/timestamp                       Get current server time
  GET     /company/{id}/employees                  Get a company's employees
  GET     /company/{id}/profile                    Get a company's profile

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `company/?selections=applications` | `/v2/company/applications` |
| `company/?selections=employees` | `/v2/company/employees` |
| `company/?selections=lookup` | `/v2/company/lookup` |
| `company/?selections=profile` | `/v2/company/profile` |
| `company/?selections=stock` | `/v2/company/stock` |
| `company/?selections=timestamp` | `/v2/company/timestamp` |

────────────────────────────────────────────────────────────────────────
  PROPERTY
  V1: /property/?selections=...  (3 selections)
  V2: /v2/property/...            (4 endpoints)
  Property details
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  lookup                         Public    
  property                       Minimal   
  timestamp                      Public    

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /property                                Get any property selection
  GET     /property/lookup                         Get all available property selections
  GET     /property/timestamp                      Get current server time
  GET     /property/{id}/property                  Get a specific property

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `property/?selections=lookup` | `/v2/property/lookup` |
| `property/?selections=timestamp` | `/v2/property/timestamp` |

────────────────────────────────────────────────────────────────────────
  RACING
  V1: /racing/?selections=...  (8 selections)
  V2: /v2/racing/...            (9 endpoints)
  Racing data (cars, tracks, races)
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  cars                           Minimal   
  carupgrades                    Minimal   
  lookup                         Public    
  race                           Minimal   
  races                          Minimal   
  records                        Minimal   
  timestamp                      Public    
  tracks                         Public    

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /racing                                  Get any Racing selection
  GET     /racing/cars                             Get cars and their racing stats
  GET     /racing/carupgrades                      Get all possible car upgrades
  GET     /racing/lookup                           Get all available racing selections
  GET     /racing/races                            Get races
  GET     /racing/timestamp                        Get current server time
  GET     /racing/tracks                           Get race tracks and descriptions
  GET     /racing/{raceId}/race                    Get specific race details
  GET     /racing/{trackId}/records                Get track records

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `racing/?selections=cars` | `/v2/racing/cars` |
| `racing/?selections=carupgrades` | `/v2/racing/carupgrades` |
| `racing/?selections=lookup` | `/v2/racing/lookup` |
| `racing/?selections=races` | `/v2/racing/races` |
| `racing/?selections=timestamp` | `/v2/racing/timestamp` |
| `racing/?selections=tracks` | `/v2/racing/tracks` |

────────────────────────────────────────────────────────────────────────
  FORUM
  V1: /forum/?selections=...  (6 selections)
  V2: /v2/forum/...            (8 endpoints)
  Forum data (threads, posts)
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  categories                     Public    
  lookup                         Public    
  posts                          Public    
  thread                         Public    
  threads                        Public    
  timestamp                      Public    

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /forum                                   Get any Forum selection
  GET     /forum/categories                        Get publicly available forum categories
  GET     /forum/lookup                            Get all available forum selections
  GET     /forum/threads                           Get threads across all forum categories
  GET     /forum/timestamp                         Get current server time
  GET     /forum/{categoryIds}/threads             Get threads for specific public forum category ...
  GET     /forum/{threadId}/posts                  Get specific forum thread posts
  GET     /forum/{threadId}/thread                 Get specific thread details

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `forum/?selections=categories` | `/v2/forum/categories` |
| `forum/?selections=lookup` | `/v2/forum/lookup` |
| `forum/?selections=threads` | `/v2/forum/threads` |
| `forum/?selections=timestamp` | `/v2/forum/timestamp` |

────────────────────────────────────────────────────────────────────────
  KEY
  V1: /key/?selections=...  (2 selections)
  V2: /v2/key/...            (3 endpoints)
  API key info and usage log
────────────────────────────────────────────────────────────────────────

  V1 Selections:
| Selection | Access Level |
|-----------|-------------|
| `Selection` | Access |

  ────────────────────────────── ──────────
  info                           Minimal   
  log                            Minimal   

  V2 Endpoints:
  Method  Path                                     Description
  ─────── ──────────────────────────────────────── ──────────────────────────────
  GET     /key                                     Get any Key selection
  GET     /key/info                                Get current key info
  GET     /key/log                                 Get current key log history

  V1→V2 Quick Mapping:
| V1 | V2 |
|----|-----|
| `key/?selections=info` | `/v2/key/info` |
| `key/?selections=log` | `/v2/key/log` |

## 7. KEY PARAMETERS BY ENDPOINT

Most V2 endpoints accept these common parameters:
  key          (required) API key
  comment      Custom comment (bypasses cache)
  timestamp    Unix timestamp (bypasses service cache)

Endpoint-specific parameters:

  USER:
    /user
      selections           List[UserSelectionName] Selection names
      id                   oneOf           selection id
      legacy               List[UserSelectionName] Legacy selection names for which you want or expect API v1 r
      cat                  oneOf           Selection category. Can belong to one of the specified types
      stat                 List[PersonalStatsStatName] Selection stat
    /user/inventory
      cat                  TornInventoryItemType Items category
    /user/list
      cat                  UserListEnum    Select list type [required]
    /user/log
      log                  List[LogId]     Log ids, comma separated, e.g. 105,4900,4905
      cat                  LogCategoryId   Log category id
      target               UserId          Get logs where you interacted with a specific player by pass
    /user/personalstats
      cat                  PersonalStatsCategoryEnum Stats category. Required unless requesting specific stats vi
      stat                 List[PersonalStatsStatName] Stat names (10 maximum). Used to fetch historical stat value
    /user/races
      cat                  RacingRaceTypeEnum Category of races returned
    /user/reports
      cat                  ReportTypeEnum  Used to filter reports with a specific type.
      target               UserId          Get reports for a specific player by passing their player ID
    /user/trades
      cat                  TradeCategoryEnum Category of trades returned
    /user/{id}/personalstats
      cat                  PersonalStatsCategoryEnum 
      stat                 List[PersonalStatsStatName] Stat names (10 maximum). Used to fetch historical stat value

  FACTION:
    /faction
      selections           List[FactionSelectionName] Selection names
      id                   oneOf           selection id
      legacy               List[FactionSelectionName] Legacy selection names for which you want or expect API v1 r
      cat                  oneOf           Selection category
      stat                 FactionStatEnum Stat category
      filters              enum(6)         
    /faction/balance
      cat                  enum(2)         By default, this selection will return only current faction'
    /faction/contributors
      stat                 FactionStatEnum Get contributors for this field. [required]
      cat                  enum(2)         By default, this selection will return only current faction'
    /faction/crimes
      cat                  enum(8)         Category of organized crimes returned. Category 'available' 
      filters              enum(4)         It's possible to set this parameter to specify a field used 
    /faction/news
      cat                  FactionNewsCategory News category type [required]
    /faction/reports
      cat                  ReportTypeEnum  Used to filter reports with a specific type.
      target               UserId          Get reports for a specific player by passing their player ID
    /faction/warfare
      cat                  FactionWarfareTypeEnum  [required]

  TORN:
    /torn
      selections           List[TornSelectionName] Selection names
      id                   oneOf           selection id
      legacy               List[TornSelectionName] Legacy selection names for which you want or expect API v1 r
      cat                  oneOf           Selection category
    /torn/attacklog
      log                  AttackCode      Code of the attack log. E.g. d51ad4fe6be884b309b142e2d1d4f80 [required]
    /torn/factionhof
      cat                  TornFactionHofCategory Leaderboards category [required]
    /torn/hof
      cat                  TornHofCategory Leaderboards category [required]
    /torn/items
      cat                  TornItemCategory Item category type
    /torn/territory
      ids                  List[FactionTerritoryEnum] Specific territory id or a list of territory ids (comma sepa

  MARKET:
    /market
      selections           List[MarketSelectionName] Selection names
      id                   oneOf           selection id
      legacy               List[MarketSelectionName] Legacy selection names for which you want or expect API v1 r
      cat                  MarketSpecializedBazaarCategoryEnum Category of specialized bazaars returned
      bonus                WeaponBonusEnum Used to filter weapons with a specific bonus
      sort                 enum(2)         Direction to sort rows in
    /market/bazaar
      cat                  MarketSpecializedBazaarCategoryEnum Category of specialized bazaars returned
    /market/{id}/itemmarket
      bonus                WeaponBonusEnum Used to filter weapons with a specific bonus.

  COMPANY:
    /company
      selections           List[CompanySelectionName] Selection names
      id                   oneOf           selection id
      legacy               List[CompanySelectionName] Legacy selection names for which you want or expect API v1 r

  PROPERTY:
    /property
      selections           List[PropertySelectionName] Selection names
      id                   PropertyId      Property id [required]

  RACING:
    /racing
      selections           List[RacingSelectionName] Selection names
      id                   oneOf           selection id
      cat                  oneOf           Selection category
    /racing/races
      cat                  RacingRaceTypeEnum Category of races returned
    /racing/{trackId}/records
      cat                  RaceClassEnum   Car class [required]

  FORUM:
    /forum
      selections           List[ForumSelectionName] Selection names
      id                   oneOf           selection id

  KEY:
    /key
      selections           List[KeySelectionName] Selection names

## 8. KEY RESPONSE SCHEMAS

#### UserStatus — Player status

| Field | Type |
|-------|------|
| `description` | `string — human-readable status` |
| `details` | `string|null — extra details` |
| `state` | `enum — Okay|Traveling|Hospital|Jail|Abroad|Federal|Fallen|Dormant|Awoken` |
| `color` | `string — green|yellow|red` |
| `until` | `int|null — timestamp when status ends` |

  UserTravel — Travel information
  ──────────────────────────────────────────────────
    destination          CountryEnum — destination country
    method               enum|null — Private|Business|Airstrip|Standard
    departed_at          int|null — departure timestamp
    arrival_at           int|null — arrival timestamp
    time_left            int — seconds remaining (0 = not traveling)

  FactionWarfareDirtyBomb — Dirty bomb record
  ──────────────────────────────────────────────────
    id                   DirtyBombId
    planted_at           int — timestamp when planted
    detonated_at         int — timestamp when detonated (0=active)
    faction              FactionWarfareDirtyBombTargetFaction — target {id,name,respect_lost}
    user                 FactionWarfareDirtyBombPlanter|null — planter {id,name}

  FactionWarfareTypeEnum — Warfare categories
  ──────────────────────────────────────────────────
    values               ranked | territory | raid | chain | chainOngoing | db

  Attack — Attack record
  ──────────────────────────────────────────────────
    id                   AttackId
    code                 AttackCode
    attacker             AttackParticipant
    defender             AttackParticipant
    result               string
    respect              int
    timestamp            int

## 9. COUNTRIES (Travel Destinations)

  Mexico, Hawaii, South Africa, Japan, China, Argentina,
  Switzerland, Canada, United Kingdom, UAE, Cayman Islands,
  Singapore

## 10. BEST PRACTICES

  1. Cache awareness
     - Service cache: 30s. Use &timestamp= to bypass when fresh data needed.
     - Global cache: Cannot bypass. Applies to market/company data.

  2. Minimize requests
     - V1: Combine multiple selections in one call
     - V2: Only request the data you need
     - Request as little data as possible per call

  3. Error handling
     - Code 5 (rate limit): Back off, respect the limit
     - Code 16 (access level): Check key permissions
     - Code 2 (wrong key): Verify key format (16 chars)

  4. Key security
     - Never expose keys in client-side code
     - Use full access key only when necessary
     - Monitor key usage via /key/?selections=log

  5. Dirty bomb detection
     - GET /torn/?selections=dirtybombs (V1)
     - GET /v2/torn/dirtybombs (V2)
     - Check if any entry has detonated=0 → active bomb
     - No API endpoint exists for post-detonation restriction status

## 11. TOOLS & CLIENTS

  Official:  https://www.torn.com/api.html (V1 docs)
             https://www.torn.com/swagger.php (V2 Swagger)
  Spec:      https://api.torn.com/swagger/openapi.json (needs key)

  Community wrappers:
    Python:  cxdzc/TornAPIWrapper
    C#:      CarlHalstead/TornCityAPISharp, Anu6is/TornCity.Net
    TS:      neon0404/torn-client (auto-generated from OpenAPI)
    HA:      xlemmingx/ha-torn (HomeAssistant integration)

## APPENDIX: COMPLETE V1 SELECTION LIST

### USER (71 selections)

`ammo`, `attacks`, `attacksfull`, `bars`, `basic`, `battlestats`, `bazaar`, `bounties`, `calendar`, `casino`, `competition`, `cooldowns`, `crimes`, `criminalrecord`, `discord`, `display`, `education`, `enlistedcars`, `equipment`, `events`, `faction`, `factionbalance`, `forumfeed`, `forumfriends`, `forumposts`, `forumsubscribedthreads`, `forumthreads`, `gym`, `hof`, `honors`, `icons`, `inventory`, `itemmarket`, `job`, `jobpoints`, `jobranks`, `list`, `log`, `lookup`, `medals`, `merits`, `messages`, `missions`, `money`, `networth`, `newevents`, `newmessages`, `notifications`, `organizedcrime`, `organizedcrimes`, `perks`, `personalstats`, `profile`, `properties`, `property`, `publicstatus`, `races`, `racingrecords`, `refills`, `reports`, `revives`, `revivesfull`, `skills`, `stocks`, `timestamp`, `trade`, `trades`, `travel`, `virus`, `weaponexp`, `workstats`

### FACTION (53 selections)

`applications`, `armor`, `armorynews`, `attacknews`, `attacks`, `attacksfull`, `balance`, `basic`, `boosters`, `caches`, `cesium`, `chain`, `chainreport`, `chains`, `contributors`, `crime`, `crimeexp`, `crimenews`, `crimes`, `currency`, `donations`, `drugs`, `fundsnews`, `hof`, `lookup`, `mainnews`, `medical`, `members`, `membershipnews`, `news`, `positions`, `rackets`, `raidreport`, `raids`, `rankedwarreport`, `rankedwars`, `reports`, `revives`, `revivesfull`, `search`, `stats`, `temporary`, `territory`, `territorynews`, `territoryownership`, `territorywarreport`, `territorywars`, `timestamp`, `upgrades`, `utilities`, `warfare`, `wars`, `weapons`

### TORN (51 selections)

`attacklog`, `bank`, `bounties`, `calendar`, `cards`, `chainreport`, `cityshops`, `companies`, `competition`, `crimes`, `dirtybombs`, `education`, `elimination`, `eliminationattacks`, `eliminationteam`, `factionhof`, `factiontree`, `gyms`, `hof`, `honors`, `itemammo`, `itemdetails`, `itemmods`, `items`, `itemstats`, `logcategories`, `logtypes`, `lookup`, `medals`, `merits`, `organisedcrimes`, `organizedcrimes`, `pawnshop`, `pokertables`, `properties`, `rackets`, `raidreport`, `raids`, `rankedwarreport`, `rankedwars`, `rockpaperscissors`, `searchforcash`, `shoplifting`, `stats`, `stocks`, `subcrimes`, `territory`, `territorynames`, `territorywarreport`, `territorywars`, `timestamp`

### MARKET (9 selections)

`auctionhouse`, `auctionhouselisting`, `bazaar`, `itemmarket`, `lookup`, `pointsmarket`, `properties`, `rentals`, `timestamp`

### COMPANY (9 selections)

`applications`, `companies`, `detailed`, `employees`, `lookup`, `news`, `profile`, `stock`, `timestamp`

### PROPERTY (3 selections)

`lookup`, `property`, `timestamp`

### RACING (8 selections)

`cars`, `carupgrades`, `lookup`, `race`, `races`, `records`, `timestamp`, `tracks`

### FORUM (6 selections)

`categories`, `lookup`, `posts`, `thread`, `threads`, `timestamp`

### KEY (2 selections)

`info`, `log`

---

*End of Document*
| Field | Type |
|-------|------|
| `description` | `string — human-readable status` |
| `details` | `string|null — extra details` |
| `state` | `enum — Okay|Traveling|Hospital|Jail|Abroad|Federal|Fallen|Dormant|Awoken` |
| `color` | `string — green|yellow|red` |
| `until` | `int|null — timestamp when status ends` |

@imps @transfer
Feature: IMPS funds transfer
  As a bank customer
  I want to send money by IMPS
  So that the recipient receives it immediately

  IMPS rules:
    - Maximum £5,000 per transaction
    - Maximum £10,000 per day
    - Transfers ABOVE £5,000 are flagged for AML review; exactly £5,000 is not
    - Amounts must be greater than zero

  Background:
    Given I am logged in as a valid customer
    And I am on the transfer page

  @happy-path
  Scenario: Valid IMPS transfer under £5,000
    When I enter amount 2500.00
    And I select transfer type "IMPS"
    And I enter recipient account "12345678"
    And I submit the transfer
    Then the transfer should be successful
    And I should not see AML review message

  @boundary @aml
  Scenario: IMPS transfer of exactly £5,000 is allowed without an AML flag
    When I enter amount 5000.00
    And I select transfer type "IMPS"
    And I enter recipient account "12345678"
    And I submit the transfer
    Then the transfer should be successful
    And I should not see AML review message

  @negative @daily-limit
  Scenario: IMPS transfer that takes the day's total to £10,001 is rejected
    Given I have already sent IMPS transfers totalling 5001.00 today
    When I enter amount 5000.00
    And I select transfer type "IMPS"
    And I enter recipient account "12345678"
    And I submit the transfer
    Then the transfer should be rejected
    And I should see error "Daily IMPS limit of £10,000 exceeded"

  @negative @validation
  Scenario: IMPS transfer with a negative amount is rejected
    When I enter amount -100.00
    And I select transfer type "IMPS"
    And I enter recipient account "12345678"
    And I submit the transfer
    Then the transfer should be rejected
    And I should see error "Amount must be greater than zero"
